/**
 * ProjectSwitcher — project selector with lifecycle badge, search, and grouped dropdown.
 *
 * Displays the active project name and lifecycle state. Opening the dropdown reveals
 * all projects split into Recent / All / Archived groups, with a real-time search filter.
 * Keyboard navigation follows listbox conventions (ArrowUp/ArrowDown, Home/End, Enter,
 * Escape). Switching projects can be guarded by an optional confirmation step.
 *
 * All backend-dependent work is delegated through props; the component never invents
 * results. It supports loading, empty, error, and recovery states out of the box.
 */

import {
  useCallback,
  useEffect,
  useId,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  AlertTriangle,
  Archive,
  Check,
  ChevronDown,
  Clock,
  FolderKanban,
  LoaderCircle,
  RefreshCw,
  Search,
  X,
} from 'lucide-react';
import './ProjectSwitcher.css';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type ProjectLifecycle =
  | 'draft'
  | 'clarified'
  | 'planned'
  | 'approved'
  | 'running'
  | 'reviewing'
  | 'completed'
  | 'archived'
  | string;

export interface ProjectItem {
  /** Stable project identifier. */
  id: string;
  /** Display name. */
  title: string;
  /** Research lifecycle state. */
  lifecycle: ProjectLifecycle;
  /** Optional subtitle shown under the title. */
  subtitle?: string;
  /** Last update timestamp (ms); used for "Recent" ordering. */
  updatedAt?: number;
  /** Non-null when the project is archived. */
  archivedAt?: number | null;
}

export interface ProjectSwitcherLabels {
  currentProject: string;
  switchProject: string;
  searchProjects: string;
  noMatches: string;
  noProjects: string;
  recent: string;
  allProjects: string;
  archived: string;
  loading: string;
  refresh: string;
  retry: string;
  closeError: string;
  cancel: string;
  confirmSwitchTitle: string;
  confirmSwitchMessage: string;
  confirmSwitchButton: string;
  lifecycle: Record<ProjectLifecycle, string>;
}

export interface ProjectSwitcherProps {
  /** All projects known to the workspace. */
  projects: ProjectItem[];
  /** Currently active project id, if any. */
  activeProjectId: string | null;
  /** Called when the user confirms a project switch. Return a Promise if the action is async. */
  onSwitch: (projectId: string) => void | Promise<void>;
  /** Called to retry loading / refresh the project list. */
  onRefresh?: () => void | Promise<void>;
  /** When true the trigger shows a loading state and the dropdown is disabled. */
  loading?: boolean;
  /** Error message to display. Cleared via `onClearError` or `onRefresh`. */
  error?: string | null;
  /** Dismiss the current error without retrying. */
  onClearError?: () => void;
  /** Maximum number of projects shown in the "Recent" group. Default 3. */
  maxRecent?: number;
  /** When true, or when it returns a string, a confirmation panel is shown before switching. */
  confirmSwitch?: boolean | ((from: ProjectItem | null, to: ProjectItem) => boolean | string);
  /** Optional copy overrides. */
  labels?: Partial<ProjectSwitcherLabels>;
  /** Additional class for the root element. */
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Default copy                                                       */
/* ------------------------------------------------------------------ */

const DEFAULT_LABELS: ProjectSwitcherLabels = {
  currentProject: '当前项目',
  switchProject: '切换项目',
  searchProjects: '搜索项目',
  noMatches: '没有匹配的项目',
  noProjects: '暂无项目',
  recent: '最近',
  allProjects: '全部项目',
  archived: '已归档',
  loading: '加载中…',
  refresh: '刷新项目列表',
  retry: '重试',
  closeError: '关闭提示',
  cancel: '取消',
  confirmSwitchTitle: '确认切换项目？',
  confirmSwitchMessage: '切换后当前未保存的更改可能会丢失。',
  confirmSwitchButton: '确认切换',
  lifecycle: {
    draft: '草稿',
    clarified: '已澄清',
    planned: '已计划',
    approved: '已批准',
    running: '进行中',
    reviewing: '审阅中',
    completed: '已完成',
    archived: '已归档',
  },
};

function resolveLabels(provided: Partial<ProjectSwitcherLabels> | undefined): ProjectSwitcherLabels {
  return {
    ...DEFAULT_LABELS,
    ...provided,
    lifecycle: { ...DEFAULT_LABELS.lifecycle, ...provided?.lifecycle },
  };
}

function lifecycleLabel(labels: ProjectSwitcherLabels, lifecycle: ProjectLifecycle): string {
  return labels.lifecycle[lifecycle] ?? lifecycle;
}

/* ------------------------------------------------------------------ */
/*  Filtering & grouping                                               */
/* ------------------------------------------------------------------ */

interface GroupedProjects {
  recent: ProjectItem[];
  all: ProjectItem[];
  archived: ProjectItem[];
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function filterProjects(projects: ProjectItem[], query: string): ProjectItem[] {
  const needle = normalize(query);
  if (!needle) return projects;
  return projects.filter((project) => {
    const haystack = normalize(`${project.title} ${project.subtitle ?? ''}`);
    return haystack.includes(needle);
  });
}

function groupProjects(
  projects: ProjectItem[],
  activeProjectId: string | null,
  maxRecent: number,
): GroupedProjects {
  const sortedByDate = [...projects].sort((a, b) => {
    const ta = a.updatedAt ?? 0;
    const tb = b.updatedAt ?? 0;
    return tb - ta || a.title.localeCompare(b.title);
  });

  const archived: ProjectItem[] = [];
  const active: ProjectItem[] = [];

  for (const project of sortedByDate) {
    if (project.archivedAt != null) {
      archived.push(project);
    } else {
      active.push(project);
    }
  }

  const activeProject = activeProjectId
    ? active.find((project) => project.id === activeProjectId) ?? null
    : null;

  const recentIds = new Set<string>();
  if (activeProject) recentIds.add(activeProject.id);
  for (const project of active) {
    if (recentIds.size >= maxRecent) break;
    recentIds.add(project.id);
  }

  const recent = active.filter((project) => recentIds.has(project.id));
  const all = active.filter((project) => !recentIds.has(project.id));

  return { recent, all, archived };
}

/* ------------------------------------------------------------------ */
/*  Confirmation helpers                                               */
/* ------------------------------------------------------------------ */

function needsConfirmation(
  confirmSwitch: ProjectSwitcherProps['confirmSwitch'],
  labels: ProjectSwitcherLabels,
  from: ProjectItem | null,
  to: ProjectItem,
): string | false {
  if (confirmSwitch === true) return labels.confirmSwitchMessage;
  if (typeof confirmSwitch === 'function') {
    const result = confirmSwitch(from, to);
    if (result === false) return false;
    if (result === true) return labels.confirmSwitchMessage;
    return result;
  }
  return false;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

type ResponsiveBand = 'wide' | 'medium' | 'narrow';

export default function ProjectSwitcher({
  projects,
  activeProjectId,
  onSwitch,
  onRefresh,
  loading = false,
  error = null,
  onClearError,
  maxRecent = 3,
  confirmSwitch = false,
  labels: labelsProp,
  className = '',
}: ProjectSwitcherProps) {
  const labels = resolveLabels(labelsProp);
  const baseId = useId().replace(/:/g, '');
  const triggerId = `${baseId}-project-switcher-trigger`;
  const searchId = `${baseId}-project-switcher-search`;
  const listboxId = `${baseId}-project-switcher-listbox`;
  const errorId = `${baseId}-project-switcher-error`;
  const confirmMessageId = `${baseId}-project-switcher-confirm-message`;

  const rootRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const listboxRef = useRef<HTMLDivElement>(null);
  const optionRefs = useRef<Array<HTMLButtonElement | null>>([]);

  const [isOpen, setIsOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [focusedIndex, setFocusedIndex] = useState(0);
  const [responsiveBand, setResponsiveBand] = useState<ResponsiveBand>('wide');
  const [confirming, setConfirming] = useState<{
    project: ProjectItem;
    message: string;
    switching: boolean;
  } | null>(null);

  const activeProject = useMemo(
    () => projects.find((project) => project.id === activeProjectId) ?? null,
    [projects, activeProjectId],
  );

  const filteredProjects = useMemo(
    () => filterProjects(projects, query),
    [projects, query],
  );

  const grouped = useMemo(
    () => groupProjects(filteredProjects, activeProjectId, maxRecent),
    [filteredProjects, activeProjectId, maxRecent],
  );

  const flattenedOptions = useMemo<ProjectItem[]>(() => {
    const { recent, all, archived } = grouped;
    return [...recent, ...all, ...archived];
  }, [grouped]);

  /* Responsive band detection */
  useLayoutEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;

    const updateBand = () => {
      const width = root.clientWidth;
      if (width <= 0) return;
      const nextBand = width <= 280 ? 'narrow' : width <= 400 ? 'medium' : 'wide';
      setResponsiveBand((prev) => (prev === nextBand ? prev : nextBand));
    };

    updateBand();
    const observer = new ResizeObserver(updateBand);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  /* Reset focus when the option list changes. */
  useEffect(() => {
    // Intentionally reset keyboard focus to the first option whenever the
    // filtered list changes (search query or grouping). This matches standard
    // listbox search behavior and avoids focus landing on a stale/out-of-range
    // option. The effect is small and localized, so an eslint disable is clearer
    // than restructuring focus state into a derived value.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedIndex(0);
  }, [query, grouped.recent.length, grouped.all.length, grouped.archived.length]);

  /* Focus the search input when the dropdown opens. */
  useEffect(() => {
    if (isOpen && !confirming) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [isOpen, confirming]);

  /* Focus the confirmation primary action when it appears. */
  useEffect(() => {
    if (confirming) {
      requestAnimationFrame(() => {
        const confirmBtn = listboxRef.current?.querySelector('[data-project-switcher-confirm]') as HTMLElement | null;
        confirmBtn?.focus();
      });
    }
  }, [confirming]);

  /* Close dropdown on outside click / Escape. */
  useEffect(() => {
    if (!isOpen) return;

    const handleMouseDown = (event: MouseEvent) => {
      const target = event.target as Node;
      if (rootRef.current && !rootRef.current.contains(target)) {
        setIsOpen(false);
        setQuery('');
        setConfirming(null);
      }
    };

    const handleKeyDown = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
        setQuery('');
        setConfirming(null);
        triggerRef.current?.focus();
      }
    };

    document.addEventListener('mousedown', handleMouseDown);
    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('mousedown', handleMouseDown);
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [isOpen]);

  const focusOption = useCallback((index: number) => {
    if (flattenedOptions.length === 0) return;
    const bounded = Math.max(0, Math.min(flattenedOptions.length - 1, index));
    setFocusedIndex(bounded);
    requestAnimationFrame(() => optionRefs.current[bounded]?.focus());
  }, [flattenedOptions.length]);

  const handleTriggerClick = useCallback(() => {
    if (loading) return;
    setIsOpen((prev) => {
      if (prev) {
        setQuery('');
        setConfirming(null);
      }
      return !prev;
    });
  }, [loading]);

  const handleTriggerKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>) => {
      if (loading) return;
      if (event.key === 'Enter' || event.key === ' ' || event.key === 'ArrowDown') {
        event.preventDefault();
        if (!isOpen) {
          setIsOpen(true);
        } else {
          focusOption(0);
        }
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        setIsOpen(true);
      }
    },
    [loading, isOpen, focusOption],
  );

  const executeSwitch = useCallback(
    async (project: ProjectItem) => {
      setConfirming((prev) => (prev ? { ...prev, switching: true } : null));
      try {
        await onSwitch(project.id);
      } finally {
        setIsOpen(false);
        setQuery('');
        setConfirming(null);
      }
    },
    [onSwitch],
  );

  const initiateSwitch = useCallback(
    (project: ProjectItem) => {
      if (project.id === activeProjectId) {
        setIsOpen(false);
        setQuery('');
        return;
      }
      const message = needsConfirmation(confirmSwitch, labels, activeProject, project);
      if (message) {
        setConfirming({ project, message, switching: false });
        return;
      }
      void executeSwitch(project);
    },
    [activeProject, activeProjectId, confirmSwitch, executeSwitch, labels],
  );

  const handleOptionKeyDown = useCallback(
    (event: KeyboardEvent<HTMLButtonElement>, index: number) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusOption(index + 1);
      } else if (event.key === 'ArrowUp') {
        event.preventDefault();
        focusOption(index - 1);
      } else if (event.key === 'Home') {
        event.preventDefault();
        focusOption(0);
      } else if (event.key === 'End') {
        event.preventDefault();
        focusOption(flattenedOptions.length - 1);
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        const project = flattenedOptions[index];
        if (project) initiateSwitch(project);
      }
    },
    [flattenedOptions, focusOption, initiateSwitch],
  );

  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        focusOption(0);
      } else if (event.key === 'Escape') {
        event.preventDefault();
        setIsOpen(false);
        setQuery('');
        triggerRef.current?.focus();
      }
    },
    [focusOption],
  );

  const handleRefresh = useCallback(() => {
    onClearError?.();
    onRefresh?.();
  }, [onClearError, onRefresh]);

  const hasGroups = grouped.recent.length > 0 || grouped.all.length > 0 || grouped.archived.length > 0;

  /* ── Render helpers ── */

  const renderOption = (project: ProjectItem, index: number) => {
    const isActive = project.id === activeProjectId;
    const isFocused = index === focusedIndex;

    return (
      <button
        key={project.id}
        id={`${baseId}-project-option-${project.id}`}
        ref={(element) => { optionRefs.current[index] = element; }}
        type="button"
        role="option"
        aria-selected={isActive}
        tabIndex={isFocused ? 0 : -1}
        data-project-index={index}
        className={`project-switcher__option ${isActive ? 'is-active' : ''}`}
        onClick={() => initiateSwitch(project)}
        onFocus={() => setFocusedIndex(index)}
        onKeyDown={(event) => handleOptionKeyDown(event, index)}
      >
        <span className="project-switcher__option-glyph" aria-hidden="true">
          {project.title.slice(0, 1).toLocaleUpperCase()}
        </span>
        <span className="project-switcher__option-copy">
          <strong>{project.title}</strong>
          {project.subtitle && <small>{project.subtitle}</small>}
        </span>
        {isActive && <Check size={14} className="project-switcher__option-check" aria-hidden="true" />}
        <span
          className={`project-switcher__option-lifecycle project-switcher__option-lifecycle--${project.lifecycle}`}
          aria-hidden="true"
        />
      </button>
    );
  };

  const renderGroup = (
    groupLabel: string,
    items: ProjectItem[],
    startIndex: number,
    icon: typeof Clock,
  ): [React.ReactNode, number] => {
    if (items.length === 0) return [null, startIndex];
    const Icon = icon;
    return [
      <div key={groupLabel} className="project-switcher__group" role="group" aria-label={groupLabel}>
        <div className="project-switcher__group-label">
          <Icon size={12} aria-hidden="true" />
          <span>{groupLabel}</span>
        </div>
        {items.map((project, i) => renderOption(project, startIndex + i))}
      </div>,
      startIndex + items.length,
    ];
  };

  let optionIndex = 0;
  const [recentNode, afterRecent] = renderGroup(labels.recent, grouped.recent, optionIndex, Clock);
  optionIndex = afterRecent;
  const [allNode, afterAll] = renderGroup(labels.allProjects, grouped.all, optionIndex, FolderKanban);
  optionIndex = afterAll;
  const [archivedNode] = renderGroup(labels.archived, grouped.archived, optionIndex, Archive);

  return (
    <div
      ref={rootRef}
      className={`project-switcher ${className}`.trim()}
      data-responsive-band={responsiveBand}
    >
      {/* Trigger */}
      <button
        ref={triggerRef}
        id={triggerId}
        type="button"
        className={`project-switcher__trigger ${isOpen ? 'is-open' : ''} ${loading ? 'is-loading' : ''}`}
        onClick={handleTriggerClick}
        onKeyDown={handleTriggerKeyDown}
        aria-haspopup="listbox"
        aria-expanded={isOpen}
        aria-controls={listboxId}
        disabled={loading && projects.length === 0}
        aria-describedby={error ? errorId : undefined}
      >
        <span className="project-switcher__trigger-main">
          <span className="project-switcher__trigger-glyph" aria-hidden="true">
            {activeProject ? activeProject.title.slice(0, 1).toLocaleUpperCase() : <FolderKanban size={15} />}
          </span>
          <span className="project-switcher__trigger-copy">
            <span className="project-switcher__trigger-label">
              {activeProject ? activeProject.title : labels.noProjects}
            </span>
            {activeProject && (
              <span className="project-switcher__trigger-meta">
                {labels.currentProject} · {lifecycleLabel(labels, activeProject.lifecycle)}
              </span>
            )}
          </span>
        </span>
        <span className="project-switcher__trigger-actions">
          {loading && <LoaderCircle size={15} className="project-switcher__spinner" aria-hidden="true" />}
          <ChevronDown
            size={15}
            className="project-switcher__trigger-chevron"
            aria-hidden="true"
          />
        </span>
      </button>

      {/* Error message */}
      {error && (
        <div id={errorId} className="project-switcher__error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <span className="project-switcher__error-text">{error}</span>
          <span className="project-switcher__error-actions">
            {onRefresh && (
              <button type="button" onClick={handleRefresh} aria-label={labels.retry}>
                {labels.retry}
              </button>
            )}
            {onClearError && (
              <button type="button" onClick={onClearError} aria-label={labels.closeError}>
                <X size={14} aria-hidden="true" />
              </button>
            )}
          </span>
        </div>
      )}

      {/* Dropdown */}
      {isOpen && (
        <div
          ref={listboxRef}
          id={listboxId}
          className="project-switcher__dropdown"
          role="listbox"
          aria-label={labels.switchProject}
          aria-activedescendant={
            flattenedOptions[focusedIndex] ? `${baseId}-project-option-${flattenedOptions[focusedIndex]?.id}` : undefined
          }
        >
          {/* Search */}
          <div className="project-switcher__search">
            <Search size={14} aria-hidden="true" />
            <input
              ref={searchRef}
              id={searchId}
              type="search"
              value={query}
              onChange={(event) => setQuery(event.target.value)}
              onKeyDown={handleSearchKeyDown}
              placeholder={labels.searchProjects}
              aria-label={labels.searchProjects}
            />
          </div>

          {/* Loading state */}
          {loading && projects.length === 0 && (
            <div className="project-switcher__loading" role="status">
              <LoaderCircle size={16} className="project-switcher__spinner" aria-hidden="true" />
              <span>{labels.loading}</span>
            </div>
          )}

          {/* Confirmation panel */}
          {confirming && (
            <div
              className="project-switcher__confirm"
              role="alertdialog"
              aria-label={labels.confirmSwitchTitle}
              aria-describedby={confirmMessageId}
            >
              <strong>{labels.confirmSwitchTitle}</strong>
              <p id={confirmMessageId}>{confirming.message}</p>
              <div className="project-switcher__confirm-actions">
                <button
                  type="button"
                  className="project-switcher__confirm-btn project-switcher__confirm-btn--secondary"
                  onClick={() => {
                    const returnTo = confirming.project;
                    setConfirming(null);
                    requestAnimationFrame(() => {
                      const index = flattenedOptions.findIndex((p) => p.id === returnTo.id);
                      if (index >= 0) focusOption(index);
                      else searchRef.current?.focus();
                    });
                  }}
                  disabled={confirming.switching}
                >
                  {labels.cancel}
                </button>
                <button
                  type="button"
                  data-project-switcher-confirm
                  className="project-switcher__confirm-btn project-switcher__confirm-btn--primary"
                  onClick={() => void executeSwitch(confirming.project)}
                  disabled={confirming.switching}
                >
                  {confirming.switching && (
                    <LoaderCircle size={14} className="project-switcher__spinner" aria-hidden="true" />
                  )}
                  {labels.confirmSwitchButton}
                </button>
              </div>
            </div>
          )}

          {/* Empty state */}
          {!confirming && !loading && !hasGroups && (
            <div className="project-switcher__empty">
              <FolderKanban size={20} aria-hidden="true" />
              <p>{query ? labels.noMatches : labels.noProjects}</p>
            </div>
          )}

          {/* Project list */}
          {!confirming && !loading && hasGroups && (
            <div className="project-switcher__list">
              {recentNode}
              {allNode}
              {archivedNode}
            </div>
          )}

          {/* Footer actions */}
          {!confirming && onRefresh && (
            <div className="project-switcher__footer">
              <button
                type="button"
                className="project-switcher__refresh"
                onClick={handleRefresh}
                disabled={loading}
                aria-label={labels.refresh}
              >
                <RefreshCw size={12} aria-hidden="true" />
                <span>{labels.refresh}</span>
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { DEFAULT_LABELS };
