/**
 * Global Search — quick access to papers, notes, experiments and pages.
 * Open with Cmd/Ctrl+K from anywhere in the app.
 */

import { useState, useMemo, useEffect, useRef, useCallback } from 'react';
import { Search } from 'lucide-react';
import { useMetisStore } from '../store';
import { useTranslation } from '../i18n';
import { Highlight } from './Highlight';
import { Input } from './ui';
import type { Page, ReadStatus } from '../store';
import { isNavVisible } from '../../engine/capabilities/DiagnosticMode';

type ResultItem = {
  id: string;
  page: Page;
  kind: 'page' | 'entity';
  entityType?: 'paper' | 'note' | 'experiment' | 'collection';
  title: string;
  subtitle: string;
  starred?: boolean;
  /** Selection target differs from the display key (full-text results carry a
   * prefixed id but must select the underlying paper). */
  selectId?: string;
};

const RECENT_SEARCHES_KEY = 'metis:recentSearches';

// Keep the permanent app rail compact, while making implemented research
// destinations reachable through the existing Cmd/Ctrl+K navigation surface.
const RESEARCH_PAGES: Page[] = [
  'projects',
  'dashboard',
  'goal',
  'timeline',
  'latex',
  'pdf',
  'notes',
  'experiments',
  'kanban',
  'outcomes',
  'submissions',
  'topics',
  'settings',
];

const PAGE_LABEL_KEYS: Record<Page, string> = {
  projects: 'nav.projects',
  settings: 'nav.settings',
  dashboard: 'nav.dashboard',
  chat: 'nav.chat',
  goal: 'nav.goal',
  kanban: 'nav.kanban',
  outcomes: 'nav.outcomes',
  submissions: 'nav.submissions',
  topics: 'nav.topics',
  timeline: 'nav.timeline',
  latex: 'nav.latexEditor',
  pdf: 'nav.pdfReader',
  notes: 'nav.notes',
  experiments: 'nav.experiments',
  evals: 'nav.evals',
};

interface GlobalSearchProps {
  onNavigate: (page: Page) => void;
  onClose: () => void;
}

export default function GlobalSearch({ onNavigate, onClose }: GlobalSearchProps) {
  const { t } = useTranslation();
  const { papers, notes, experiments, setSelectedPaperId, selectNote, setExperimentSearchQuery } = useMetisStore();
  const [query, setQuery] = useState('');
  const [selectedIndex, setSelectedIndex] = useState(0);
  const [typeFilter, setTypeFilter] = useState<'all' | 'page' | 'paper' | 'note' | 'experiment' | 'collection'>('all');
  const [starredOnly, setStarredOnly] = useState(false);
  // Full-text mode searches paper bodies in the main process (the renderer
  // never holds pdfText). Off by default; results are merged into the list.
  const [fullTextMode, setFullTextMode] = useState(false);
  const [fullTextResults, setFullTextResults] = useState<Array<{ id: string; title: string; snippet: string }>>([]);
  const [fullTextLoading, setFullTextLoading] = useState(false);
  const [recentSearches, setRecentSearches] = useState<string[]>(() => {
    try {
      const raw = localStorage.getItem(RECENT_SEARCHES_KEY);
      return raw ? (JSON.parse(raw) as string[]) : [];
    } catch { return []; }
  });
  const inputRef = useRef<HTMLInputElement>(null);
  const overlayRef = useRef<HTMLDivElement>(null);
  const searchablePages = useMemo<Page[]>(
    () => isNavVisible('evals') ? [...RESEARCH_PAGES, 'evals'] : RESEARCH_PAGES,
    [],
  );

  useEffect(() => {
    inputRef.current?.focus();
  }, []);

  // A11Y-001: restore focus to the previously focused element when the dialog
  // closes, so keyboard users never get stranded inside the overlay.
  useEffect(() => {
    const previouslyFocused = document.activeElement instanceof HTMLElement
      ? document.activeElement
      : null;
    return () => {
      if (previouslyFocused && typeof previouslyFocused.focus === 'function') {
        previouslyFocused.focus();
      }
    };
  }, []);

  const saveRecentSearch = useCallback((q: string) => {
    const trimmed = q.trim();
    if (!trimmed) return;
    setRecentSearches((prev) => {
      const next = [trimmed, ...prev.filter((item) => item !== trimmed)].slice(0, 10);
      try { localStorage.setItem(RECENT_SEARCHES_KEY, JSON.stringify(next)); } catch { /* ignore */ }
      return next;
    });
  }, []);

  const clearRecentSearches = useCallback(() => {
    setRecentSearches([]);
    try { localStorage.removeItem(RECENT_SEARCHES_KEY); } catch { /* ignore */ }
  }, []);

  const searchParams = useMemo(() => {
    const trimmed = query.trim();
    const tagMatch = trimmed.match(/^tag:(.+)/i) ?? trimmed.match(/^#(.+)/);
    const tag = tagMatch ? (tagMatch[1] ?? '').trim().toLowerCase() : null;
    const priorityMatch = trimmed.match(/\b(?:priority|p):(high|medium|low)\b/i);
    const priority = priorityMatch ? (priorityMatch[1] ?? '').toLowerCase() as 'high' | 'medium' | 'low' : null;
    const deadlineMatch = trimmed.match(/\b(?:deadline|d):(overdue|today|upcoming)\b/i);
    const deadline = deadlineMatch ? (deadlineMatch[1] ?? '').toLowerCase() as 'overdue' | 'today' | 'upcoming' : null;
    const statusMatch = trimmed.match(/\bstatus:(unread|reading|read|skimmed)\b/i);
    const status = statusMatch ? (statusMatch[1] ?? '').toLowerCase() as ReadStatus : null;
    const isMatch = trimmed.match(/\bis:(starred|archived)\b/i);
    const isFilter = isMatch ? (isMatch[1] ?? '').toLowerCase() as 'starred' | 'archived' : null;
    const yearMatch = trimmed.match(/\byear:(\d{4})\b/i);
    const year = yearMatch ? parseInt(yearMatch[1] ?? '0', 10) : null;
    const ratingMatch = trimmed.match(/\brating:(\d)(\+)?/i);
    const ratingValue = ratingMatch ? parseInt(ratingMatch[1] ?? '0', 10) : null;
    const ratingMin = ratingMatch && ratingMatch[2] === '+' ? ratingValue : null;
    const ratingExact = ratingMatch && ratingMatch[2] !== '+' ? ratingValue : null;
    const text = tag ? '' : trimmed.replace(/\b(?:priority|p|deadline|d|status|is|year|rating):\S+/gi, '').trim().toLowerCase();
    return { tag, text, priority, deadline, status, isFilter, year, ratingMin, ratingExact };
  }, [query]);

  const results = useMemo(() => {
    const { tag, text, priority, deadline, status, isFilter, year, ratingMin, ratingExact } = searchParams;
    const hasFilter = tag || priority || deadline || status || isFilter || year !== null || ratingMin !== null || ratingExact !== null;
    if (!tag && !text && !priority && !deadline && !status && !isFilter && year === null && ratingMin === null && ratingExact === null) return [];

    const scored: { item: ResultItem; score: number }[] = [];

    function scoreMatch(value: string): number {
      if (!text) return 0;
      const lower = value.toLowerCase();
      if (lower.startsWith(text)) return 10;
      if (lower.includes(text)) return 5;
      return 0;
    }

    function matchesDeadline(paperDeadline?: string, filter?: 'overdue' | 'today' | 'upcoming'): boolean {
      if (!filter) return true;
      if (!paperDeadline) return false;
      const d = new Date(paperDeadline).setHours(0, 0, 0, 0);
      const today = new Date().setHours(0, 0, 0, 0);
      if (filter === 'overdue') return d < today;
      if (filter === 'today') return d === today;
      return d > today;
    }

    // Page navigation results: matching page labels rank highly.
    for (const page of searchablePages) {
      const label = t(PAGE_LABEL_KEYS[page]);
      const score = scoreMatch(label);
      if (score > 0) {
        scored.push({
          item: {
            id: page,
            page,
            kind: 'page',
            title: label,
            subtitle: t('globalSearch.jumpToPage'),
          },
          score,
        });
      }
    }

    for (const paper of papers) {
      const hasTag = tag ? paper.tags.some((t) => t.toLowerCase() === tag) : false;
      if (tag && !hasTag) continue;
      if (priority && paper.priority !== priority) continue;
      if (!matchesDeadline(paper.deadline, deadline ?? undefined)) continue;
      if (status && paper.readStatus !== status) continue;
      if (isFilter === 'starred' && !paper.starred) continue;
      if (isFilter === 'archived' && !paper.archived) continue;
      if (year !== null && paper.year !== year) continue;
      if (ratingExact !== null && paper.rating !== ratingExact) continue;
      if (ratingMin !== null && paper.rating < ratingMin) continue;
      const titleScore = scoreMatch(paper.title);
      const otherText = [paper.authors.join(' '), paper.abstract, paper.tags.join(' '), paper.notes, paper.pdfText ?? ''].join(' ').toLowerCase();
      const score = hasFilter ? (titleScore || (text && otherText.includes(text) ? 1 : 0) || 1) : (titleScore || (otherText.includes(text) ? 1 : 0));
      if (score > 0) {
        scored.push({
          item: {
            id: paper.id,
            page: 'pdf',
            kind: 'entity',
            entityType: 'paper',
            title: paper.title || t('papers.untitled'),
            subtitle: paper.authors.slice(0, 2).join(', ') || t('papers.unknownAuthors'),
            starred: paper.starred,
          },
          score,
        });
      }
    }

    for (const note of notes) {
      const hasTag = tag ? note.tags.some((t) => t.toLowerCase() === tag) : false;
      if (tag && !hasTag) continue;
      const titleScore = scoreMatch(note.title);
      const otherText = [note.content, note.tags.join(' ')].join(' ').toLowerCase();
      const score = tag ? (hasTag ? 1 : 0) : (titleScore || (otherText.includes(text) ? 1 : 0));
      if (score > 0) {
        scored.push({
          item: {
            id: note.id,
            page: 'notes',
            kind: 'entity',
            entityType: 'note',
            title: note.title || t('notes.defaultTitle'),
            subtitle: note.content.slice(0, 60).replace(/\n/g, ' ') || '',
            starred: note.starred,
          },
          score,
        });
      }
    }

    for (const exp of experiments) {
      const hasTag = tag ? exp.tags.some((t) => t.toLowerCase() === tag) : false;
      if (tag && !hasTag) continue;
      const nameScore = scoreMatch(exp.name);
      const otherText = [exp.description, exp.notes, exp.tags.join(' '), Object.entries(exp.parameters).map(([k, v]) => `${k} ${v}`).join(' ')].join(' ').toLowerCase();
      const score = tag ? (hasTag ? 1 : 0) : (nameScore || (otherText.includes(text) ? 1 : 0));
      if (score > 0) {
        scored.push({
          item: {
            id: exp.id,
            page: 'experiments',
            kind: 'entity',
            entityType: 'experiment',
            title: exp.name,
            subtitle: `${exp.status}${exp.description ? ` · ${exp.description.slice(0, 40)}` : ''}`,
            starred: exp.starred,
          },
          score,
        });
      }
    }

    const filtered = scored.filter(({ item }) => {
      if (typeFilter === 'page') return item.kind === 'page';
      if (typeFilter !== 'all') return item.entityType === typeFilter;
      return true;
    }).filter(({ item }) => !starredOnly || item.starred);

    filtered.sort((a, b) => b.score - a.score);
    return filtered.slice(0, 20).map((s) => s.item);
  }, [searchParams, searchablePages, papers, notes, experiments, t, typeFilter, starredOnly]);

  // ── Full-text paper-body search (main process, debounced) ──
  const fullTextQuery = searchParams.text ?? '';
  useEffect(() => {
    if (!fullTextMode || !window.metis?.searchPapersFullText) {
      // eslint-disable-next-line react-hooks/set-state-in-effect -- reset stale results when the mode/capability disappears
      setFullTextResults([]);
      setFullTextLoading(false);
      return;
    }
    if (fullTextQuery.length < 2) {
      setFullTextResults([]);
      setFullTextLoading(false);
      return;
    }
    setFullTextLoading(true);
    let cancelled = false;
    const timer = window.setTimeout(() => {
      void window.metis!.searchPapersFullText!(fullTextQuery)
        .then((result) => {
          if (cancelled) return;
          setFullTextResults(result?.results ?? []);
          setFullTextLoading(false);
        })
        .catch(() => {
          if (cancelled) return;
          setFullTextResults([]);
          setFullTextLoading(false);
        });
    }, 300);
    return () => { cancelled = true; window.clearTimeout(timer); };
  }, [fullTextMode, fullTextQuery]);

  // Merge full-text hits into the local results. A paper matched by both
  // sources is represented once, by the full-text hit (richer snippet).
  const mergedResults = useMemo(() => {
    if (fullTextResults.length === 0) return results;
    const fullTextIds = new Set(fullTextResults.map((hit) => hit.id));
    const local = results.filter(
      (item) => !(item.entityType === 'paper' && fullTextIds.has(item.id)),
    );
    const fullTextItems: ResultItem[] = fullTextResults.map((hit) => ({
      id: `fulltext-${hit.id}`,
      page: 'pdf',
      kind: 'entity',
      entityType: 'paper',
      title: hit.title,
      subtitle: hit.snippet,
      selectId: hit.id,
    }));
    return [...local, ...fullTextItems];
  }, [results, fullTextResults]);

  // Keep the selected index within bounds if the result list shrinks.
  const safeSelectedIndex = selectedIndex < mergedResults.length ? selectedIndex : Math.max(0, mergedResults.length - 1);

  const handleSelect = useCallback((item: ResultItem) => {
    saveRecentSearch(query);
    if (item.kind === 'entity') {
      if (item.page === 'pdf') {
        setSelectedPaperId(item.selectId ?? item.id);
      } else if (item.page === 'notes') {
        selectNote(item.id);
      } else if (item.page === 'experiments') {
        const exp = experiments.find((e) => e.id === item.id);
        if (exp) setExperimentSearchQuery(exp.name);
      }
    }
    onNavigate(item.page);
    onClose();
  }, [experiments, onClose, onNavigate, query, saveRecentSearch, selectNote, setExperimentSearchQuery, setSelectedPaperId]);

  useEffect(() => {
    function handleKeyDown(e: KeyboardEvent) {
      if (e.key === 'Escape') {
        onClose();
        return;
      }
      // A11Y-001: keep Tab focus cycling inside the modal dialog so keyboard
      // navigation never leaks into the background page.
      if (e.key === 'Tab' && overlayRef.current) {
        const focusables = [...overlayRef.current.querySelectorAll<HTMLElement>(
          'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
        )].filter((element) => element.offsetParent !== null || element === document.activeElement);
        if (focusables.length > 0) {
          const first = focusables[0]!;
          const last = focusables[focusables.length - 1]!;
          if (e.shiftKey && (document.activeElement === first || document.activeElement === overlayRef.current)) {
            e.preventDefault();
            last.focus();
          } else if (!e.shiftKey && document.activeElement === last) {
            e.preventDefault();
            first.focus();
          }
        }
        return;
      }
      if (mergedResults.length === 0) return;
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        setSelectedIndex((idx) => (idx + 1) % mergedResults.length);
      } else if (e.key === 'ArrowUp') {
        e.preventDefault();
        setSelectedIndex((idx) => (idx - 1 + mergedResults.length) % mergedResults.length);
      } else if (e.key === 'Enter') {
        e.preventDefault();
        handleSelect(mergedResults[safeSelectedIndex]!);
      }
    }
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [onClose, mergedResults, safeSelectedIndex, handleSelect]);

  return (
    <div
      ref={overlayRef}
      className="modal-overlay"
      role="dialog"
      aria-modal="true"
      aria-label={t('globalSearch.title')}
      onClick={onClose}
      style={{ alignItems: 'flex-start', paddingTop: '10vh' }}
    >
      <div
        className="modal"
        style={{ width: 560, maxWidth: '90vw', padding: 0, overflow: 'hidden' }}
        onClick={(e) => e.stopPropagation()}
      >
        <div style={{ padding: '12px 16px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
          <Search size={16} color="var(--text-muted)" aria-hidden="true" />
          <Input
            ref={inputRef}
            type="text"
            value={query}
            onChange={(e) => { setQuery(e.target.value); setSelectedIndex(0); }}
            placeholder={t('globalSearch.placeholder')}
            style={{ border: 'none', padding: 0, background: 'transparent', boxShadow: 'none' }}
          />
        </div>
        <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6, padding: '8px 16px', borderBottom: '1px solid var(--border)' }}>
          {(['all', 'page', 'paper', 'note', 'experiment', 'collection'] as const).map((type) => (
            <button
              key={type}
              type="button"
              data-testid={`type-filter-${type}`}
              className={`btn-sm ${typeFilter === type ? 'btn-primary' : 'btn-secondary'}`}
              onClick={() => { setTypeFilter(type); setSelectedIndex(0); }}
            >
              {t(`globalSearch.filter${type.charAt(0).toUpperCase() + type.slice(1)}`)}
            </button>
          ))}
          <button
            type="button"
            data-testid="fulltext-toggle"
            className={`btn-sm ${fullTextMode ? 'btn-primary' : 'btn-secondary'}`}
            onClick={() => { setFullTextMode((v) => !v); setSelectedIndex(0); }}
          >
            {t('globalSearch.filterFullText')}
          </button>
          <label style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 12, cursor: 'pointer', marginLeft: 'auto' }}>
            <input type="checkbox" checked={starredOnly} onChange={(e) => { setStarredOnly(e.target.checked); setSelectedIndex(0); }} />
            {t('globalSearch.filterStarred')}
          </label>
        </div>
        <div style={{ maxHeight: '60vh', overflowY: 'auto', padding: '8px 0' }}>
          {fullTextLoading && (
            <div style={{ padding: '8px 16px', fontSize: 12, color: 'var(--text-secondary)' }}>
              {t('globalSearch.fullTextSearching')}
            </div>
          )}
          {query.trim() === '' && recentSearches.length > 0 && (
            <div style={{ padding: '8px 16px 12px', borderBottom: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: 6 }}>
                <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-primary)' }}>{t('globalSearch.recentSearches')}</span>
                <button
                  type="button"
                  className="btn-sm btn-secondary"
                  onClick={clearRecentSearches}
                  data-testid="clear-recent-searches"
                >
                  {t('globalSearch.clearRecent')}
                </button>
              </div>
              <div style={{ display: 'flex', flexWrap: 'wrap', gap: 6 }}>
                {recentSearches.map((recent) => (
                  <button
                    key={recent}
                    type="button"
                    className="btn-sm btn-secondary"
                    data-testid="recent-search-item"
                    onClick={() => { setQuery(recent); setSelectedIndex(0); }}
                  >
                    {recent}
                  </button>
                ))}
              </div>
            </div>
          )}
          {mergedResults.length === 0 && query.trim() !== '' && (
            <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('globalSearch.noResults')}
            </div>
          )}
          {mergedResults.length === 0 && query.trim() === '' && recentSearches.length === 0 && (
            <div style={{ padding: '16px 20px', fontSize: 13, color: 'var(--text-secondary)' }}>
              {t('globalSearch.hint')}
            </div>
          )}
          {mergedResults.map((item, idx) => (
            <button
              key={`${item.page}-${item.id}`}
              data-testid="search-result"
              data-selected={idx === safeSelectedIndex}
              onClick={() => handleSelect(item)}
              onMouseEnter={() => setSelectedIndex(idx)}
              style={{
                display: 'flex',
                flexDirection: 'column',
                width: '100%',
                textAlign: 'left',
                padding: '8px 16px',
                border: 'none',
                background: idx === safeSelectedIndex ? 'var(--bg-hover)' : 'transparent',
                cursor: 'pointer',
                color: 'var(--text-primary)',
              }}
            >
              <span style={{ fontSize: 13, fontWeight: 500 }}>
                <Highlight text={item.title} query={query} />
              </span>
              <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>
                {item.kind === 'page'
                  ? <Highlight text={item.subtitle} query={query} />
                  : <>{t(`globalSearch.${item.page}`)} · <Highlight text={item.subtitle} query={query} /></>}
              </span>
            </button>
          ))}
        </div>
        <div
          style={{
            display: 'flex',
            gap: 12,
            padding: '8px 16px',
            borderTop: '1px solid var(--border)',
            fontSize: 11,
            color: 'var(--text-muted)',
          }}
        >
          <span>{t('globalSearch.footerNavigate')}</span>
          <span>{t('globalSearch.footerClose')}</span>
        </div>
      </div>
    </div>
  );
}
