/**
 * ProjectShell — the three-column unified research desktop (METIS-501).
 *
 *   ┌────────────┬─────────────────────────┬──────────────┐
 *   │ Left:      │ Center: workspace       │ Right:       │
 *   │ project +  │ (one of converse/read/  │ Metis / plan │
 *   │ source tree│  analyze/write modes)   │ / evidence   │
 *   └────────────┴─────────────────────────┴──────────────┘
 *
 * Implements the information architecture from METIS-103/104: three top-level entries
 * (projects / library / settings) collapse into the left nav; inside a project the four
 * modes share ONE central workspace; the right inspector shows Metis chat / research plan
 * / evidence depending on what the center has selected (METIS-504).
 *
 * Container-responsive: at <=1200px the right panel moves to a rail; at <=900px both
 * panels move to rails. A panel reopened in a responsive band is an overlay, preserving the
 * center workspace width without horizontal overflow (METIS-501 completion).
 *
 * This shell is self-contained and testable: the three regions are slots so existing page
 * components can be dropped in without modification. Automated tests assert structure,
 * responsive behavior, and accessibility; Electron acceptance captures review screenshots.
 */

import {
  useState,
  useCallback,
  useId,
  useLayoutEffect,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import './ProjectShell.css';
import CommandBar, { type CommandItem, type CommandGroup } from './CommandBar';
import Breadcrumbs, { type BreadcrumbItem } from './Breadcrumbs';
import ObjectTabs, { type ObjectTab } from './ObjectTabs';
import SplitPreview from './SplitPreview';
import VersionDiffReviewer, { type VersionItem, type ReviewComment, type DiffViewMode } from './VersionDiffReviewer';
import RecycleRestore, { type RecycleItem } from './RecycleRestore';
import RunTimelineBanner, { type RunRecord } from './RunTimelineBanner';
import SelectionActionBar from './SelectionActionBar';
import ProjectSwitcher, { type ProjectItem } from './ProjectSwitcher';
import ImportCreateDialog from './ImportCreateDialog';

export type WorkspaceMode = 'converse' | 'write' | 'projects';
export type InspectorTab = 'metis' | 'plan' | 'evidence' | 'properties';

export interface ProjectShellProps {
  /** Left column: project list + source tree (METIS-502). */
  leftPanel: ReactNode;
  /** Center column: the active mode's workspace (METIS-503). */
  children: ReactNode;
  /** Right column content per active inspector tab (METIS-504). */
  inspector?: Partial<Record<InspectorTab, ReactNode>>;
  /** Raw right-column content for workspaces that own their own tabs. */
  rightPanel?: ReactNode;
  /** Optional modifier for workspace-specific sizing and overflow. */
  workspaceClassName?: string;
  /** Currently active workspace mode (controls the center's mode switcher). */
  mode: WorkspaceMode;
  onModeChange: (mode: WorkspaceMode) => void;
  /** The global application top bar may own mode navigation. Default keeps the shell self-contained. */
  showModeSwitcher?: boolean;
  /** Controlled collapse state, used to preserve layout across workspace modes. */
  leftCollapsed?: boolean;
  rightCollapsed?: boolean;
  onLeftCollapsedChange?: (collapsed: boolean) => void;
  onRightCollapsedChange?: (collapsed: boolean) => void;
  /** Initial collapse state for uncontrolled use. */
  initialLeftCollapsed?: boolean;
  initialRightCollapsed?: boolean;

  // KIMI-201: global workspace chrome (all optional to keep the shell reusable).
  /** Project switcher state. When provided, a switcher is rendered in the workspace header. */
  projectSwitcher?: {
    projects: ProjectItem[];
    activeProjectId: string | null;
    onSwitch: (projectId: string) => void | Promise<void>;
    loading?: boolean;
    error?: string | null;
    onRefresh?: () => void;
  };
  /** Command bar state. When provided, a global command palette is available. */
  commandBar?: {
    isOpen: boolean;
    onOpen: () => void;
    onClose: () => void;
    commands: CommandItem[];
    groups?: CommandGroup[];
    loading?: boolean;
    error?: string;
    onRetry?: () => void;
  };
  /** Breadcrumb trail shown in the workspace header. */
  breadcrumbs?: BreadcrumbItem[];
  /** Called when a breadcrumb is activated. */
  onBreadcrumbNavigate?: (item: BreadcrumbItem, index: number) => void;
  /** Object tabs rendered below the mode switcher. */
  objectTabs?: ObjectTab[];
  activeObjectTabId?: string | null;
  onObjectTabSelect?: (id: string) => void;
  onObjectTabClose?: (id: string) => void | Promise<boolean | void>;
  onObjectTabNew?: () => void;
  onObjectTabReorder?: (fromIndex: number, toIndex: number) => void;
  /** Run timeline banner rendered above the shell. */
  runTimeline?: {
    runs: RunRecord[];
    isLoading?: boolean;
    error?: Error | string | null;
    onRetry?: () => void;
    onResume?: (runId: string) => void;
    onView?: (runId: string) => void;
    onTerminate?: (runId: string) => void;
    onDismiss?: () => void;
  };
  /** Selection action bar rendered at the bottom of the center workspace. */
  selectionActionBar?: {
    selectedCount: number;
    onClearSelection: () => void;
    onDeleteSelected?: () => void | Promise<void>;
    onRestoreSelected?: () => void | Promise<void>;
    onExportSelected?: () => void | Promise<void>;
    extraActions?: Parameters<typeof SelectionActionBar>[0]['extraActions'];
    loading?: boolean;
    error?: string;
    onRetry?: () => void;
  };
  /** Import / create project dialog. */
  importCreate?: {
    isOpen: boolean;
    onOpen: () => void;
    onClose: () => void;
    onCreateProject?: (payload: import('./ImportCreateDialog').CreateProjectPayload) => Promise<import('./ImportCreateDialog').CreateProjectResult>;
    onImportFiles?: (files: File[], meta: { projectId?: string }) => Promise<import('./ImportCreateDialog').ImportFilesResult>;
  };
  /** Split preview state. When enabled, the workspace content is wrapped in a split pane. */
  splitPreview?: {
    enabled: boolean;
    split?: number;
    onSplitChange?: (split: number) => void;
    primary?: ReactNode;
    secondary?: ReactNode;
    orientation?: 'horizontal' | 'vertical';
    primaryCollapsed?: boolean;
    onPrimaryCollapsedChange?: (collapsed: boolean) => void;
    secondaryCollapsed?: boolean;
    onSecondaryCollapsedChange?: (collapsed: boolean) => void;
    syncScroll?: boolean;
    onSyncScrollChange?: (sync: boolean) => void;
  };
  /** Version / diff / reviewer state rendered as a workspace overlay. */
  versionDiffReviewer?: {
    versions: VersionItem[];
    reviews?: ReviewComment[];
    baseVersionId?: string | null;
    targetVersionId?: string | null;
    viewMode?: DiffViewMode;
    activeReviewId?: string | null;
    loading?: boolean;
    error?: string | null;
    onRetry?: () => void;
    onBaseVersionChange?: (id: string) => void;
    onTargetVersionChange?: (id: string) => void;
    onViewModeChange?: (mode: DiffViewMode) => void;
    onReviewSelect?: (id: string | null) => void;
    onResolveReview?: (id: string, resolved: boolean) => void;
    onAddReviewComment?: (comment: { line?: number; text: string }) => void;
    onApprove?: () => void;
    onReject?: () => void;
    onRequestChanges?: () => void;
  };
  /** Recycle / restore panel rendered as a workspace overlay. */
  recycleRestore?: {
    items: RecycleItem[];
    loading?: boolean;
    error?: string | null;
    recoveryMessage?: string | null;
    onDismissRecovery?: () => void;
    onRefresh?: () => void;
    onRestore?: (ids: string[]) => void | Promise<void>;
    onDeleteForever?: (ids: string[]) => void | Promise<void>;
  };
}

const MODE_ORDER: WorkspaceMode[] = ['converse', 'write'];
const MODE_LABELS: Record<WorkspaceMode, string> = {
  converse: '对话',
  write: '研究写作',
  projects: '科研项目',
};
const INSPECTOR_TAB_LABELS: Record<InspectorTab, string> = {
  metis: 'Metis',
  plan: '研究计划',
  evidence: '证据',
  properties: '属性',
};

function getFocusableElements(container: HTMLElement): HTMLElement[] {
  const selector = [
    'button:not([disabled])',
    'a[href]',
    'input:not([disabled])',
    'select:not([disabled])',
    'textarea:not([disabled])',
    '[tabindex]:not([tabindex="-1"])',
    '[contenteditable="true"]',
  ].join(',');
  return Array.from(container.querySelectorAll<HTMLElement>(selector))
    .filter((element) => !element.hidden && !element.closest('[inert]'));
}

export default function ProjectShell({
  leftPanel,
  children,
  inspector = {},
  rightPanel,
  workspaceClassName = '',
  mode,
  onModeChange,
  showModeSwitcher = true,
  leftCollapsed: controlledLeftCollapsed,
  rightCollapsed: controlledRightCollapsed,
  onLeftCollapsedChange,
  onRightCollapsedChange,
  initialLeftCollapsed = false,
  initialRightCollapsed = false,
  projectSwitcher,
  commandBar,
  breadcrumbs,
  onBreadcrumbNavigate,
  objectTabs,
  activeObjectTabId,
  onObjectTabSelect,
  onObjectTabClose,
  onObjectTabNew,
  onObjectTabReorder,
  runTimeline,
  selectionActionBar,
  importCreate,
  splitPreview,
  versionDiffReviewer,
  recycleRestore,
}: ProjectShellProps) {
  const instanceId = useId().replace(/:/g, '');
  const leftPanelId = `${instanceId}-project-shell-left-panel`;
  const workspaceId = `${instanceId}-project-shell-workspace`;
  const rightPanelId = `${instanceId}-project-shell-right-panel`;
  const inspectorPanelId = `${instanceId}-project-shell-inspector-panel`;
  const shellRef = useRef<HTMLDivElement>(null);
  const leftToggleRef = useRef<HTMLButtonElement>(null);
  const rightToggleRef = useRef<HTMLButtonElement>(null);
  const leftAsideRef = useRef<HTMLElement>(null);
  const centerRef = useRef<HTMLElement>(null);
  const rightAsideRef = useRef<HTMLElement>(null);
  const leftContentRef = useRef<HTMLDivElement>(null);
  const rightContentRef = useRef<HTMLDivElement>(null);
  const modeTabRefs = useRef<Partial<Record<WorkspaceMode, HTMLButtonElement | null>>>({});
  const inspectorTabRefs = useRef<Partial<Record<InspectorTab, HTMLButtonElement | null>>>({});
  const [uncontrolledLeftCollapsed, setUncontrolledLeftCollapsed] = useState(initialLeftCollapsed);
  const [uncontrolledRightCollapsed, setUncontrolledRightCollapsed] = useState(initialRightCollapsed);
  const [activeTab, setActiveTab] = useState<InspectorTab>('metis');
  const [responsiveBand, setResponsiveBand] = useState<'wide' | 'medium' | 'narrow'>('wide');
  const responsiveBandRef = useRef(responsiveBand);
  const userLeftCollapsed = controlledLeftCollapsed ?? uncontrolledLeftCollapsed;
  const userRightCollapsed = controlledRightCollapsed ?? uncontrolledRightCollapsed;
  const responsiveLeftCollapsed = responsiveBand === 'narrow';
  const responsiveRightCollapsed = responsiveBand !== 'wide';
  const [overlaySide, setOverlaySide] = useState<'left' | 'right' | null>(null);
  const leftOverlayOpen = overlaySide === 'left';
  const rightOverlayOpen = overlaySide === 'right';
  const leftCollapsed = userLeftCollapsed || responsiveLeftCollapsed;
  const rightCollapsed = userRightCollapsed || responsiveRightCollapsed;
  const leftContentVisible = !leftCollapsed || leftOverlayOpen;
  const rightContentVisible = !rightCollapsed || rightOverlayOpen;

  const toggleLeft = useCallback(() => {
    if (responsiveLeftCollapsed) {
      setOverlaySide((side) => side === 'left' ? null : 'left');
      return;
    }

    const next = !userLeftCollapsed;
    if (controlledLeftCollapsed === undefined) setUncontrolledLeftCollapsed(next);
    onLeftCollapsedChange?.(next);
  }, [
    controlledLeftCollapsed,
    onLeftCollapsedChange,
    responsiveLeftCollapsed,
    userLeftCollapsed,
  ]);
  const toggleRight = useCallback(() => {
    if (responsiveRightCollapsed) {
      setOverlaySide((side) => side === 'right' ? null : 'right');
      return;
    }

    const next = !userRightCollapsed;
    if (controlledRightCollapsed === undefined) setUncontrolledRightCollapsed(next);
    onRightCollapsedChange?.(next);
  }, [
    controlledRightCollapsed,
    onRightCollapsedChange,
    responsiveRightCollapsed,
    userRightCollapsed,
  ]);

  useLayoutEffect(() => {
    const shell = shellRef.current;
    if (!shell || typeof ResizeObserver === 'undefined') return;

    const updateResponsiveBand = () => {
      const width = shell.clientWidth;
      if (width <= 0) return;
      const nextBand = width <= 900 ? 'narrow' : width <= 1200 ? 'medium' : 'wide';
      if (responsiveBandRef.current !== nextBand) {
        responsiveBandRef.current = nextBand;
        setResponsiveBand(nextBand);
        setOverlaySide(null);
      }
    };

    updateResponsiveBand();
    const observer = new ResizeObserver(updateResponsiveBand);

    observer.observe(shell);
    window.addEventListener('resize', updateResponsiveBand);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', updateResponsiveBand);
    };
  }, []);

  const closeOverlay = useCallback((restoreFocus = true) => {
    const closingSide = overlaySide;
    setOverlaySide(null);
    if (!restoreFocus || !closingSide) return;
    queueMicrotask(() => {
      if (closingSide === 'left') leftToggleRef.current?.focus();
      else rightToggleRef.current?.focus();
    });
  }, [overlaySide]);

  useLayoutEffect(() => {
    if (!overlaySide) return;
    const dialog = overlaySide === 'left' ? leftContentRef.current : rightContentRef.current;
    if (!dialog) return;

    const focusable = getFocusableElements(dialog);
    (focusable[0] ?? dialog).focus();

    const shell = shellRef.current;
    const app = shell?.closest('.app-layout');
    const inertTargets: HTMLElement[] = [];
    if (centerRef.current) inertTargets.push(centerRef.current);
    if (overlaySide === 'left' && rightAsideRef.current) inertTargets.push(rightAsideRef.current);
    if (overlaySide === 'right' && leftAsideRef.current) inertTargets.push(leftAsideRef.current);
    if (app) {
      for (const child of Array.from(app.children)) {
        if (child instanceof HTMLElement && child !== shell?.closest('.main-content')) inertTargets.push(child);
      }
    }
    const previous = inertTargets.map((element) => ({
      element,
      inert: element.inert,
      ariaHidden: element.getAttribute('aria-hidden'),
    }));
    for (const target of inertTargets) {
      target.inert = true;
      target.setAttribute('aria-hidden', 'true');
    }
    return () => {
      for (const item of previous) {
        item.element.inert = item.inert;
        if (item.ariaHidden === null) item.element.removeAttribute('aria-hidden');
        else item.element.setAttribute('aria-hidden', item.ariaHidden);
      }
    };
  }, [overlaySide]);

  const handleOverlayKeyDown = useCallback((event: KeyboardEvent, side: 'left' | 'right') => {
    if (overlaySide !== side) return;
    if (event.key === 'Escape') {
      event.preventDefault();
      event.stopPropagation();
      closeOverlay();
      return;
    }
    if (event.key !== 'Tab') return;
    const dialog = side === 'left' ? leftContentRef.current : rightContentRef.current;
    if (!dialog) return;
    const focusable = getFocusableElements(dialog);
    if (focusable.length === 0) {
      event.preventDefault();
      dialog.focus();
      return;
    }
    const activeIndex = focusable.indexOf(document.activeElement as HTMLElement);
    const nextIndex = event.shiftKey
      ? (activeIndex <= 0 ? focusable.length - 1 : activeIndex - 1)
      : (activeIndex < 0 || activeIndex === focusable.length - 1 ? 0 : activeIndex + 1);
    event.preventDefault();
    focusable[nextIndex]?.focus();
  }, [closeOverlay, overlaySide]);

  const handleModeTabKeyDown = useCallback((event: KeyboardEvent, currentMode: WorkspaceMode) => {
    const currentIndex = MODE_ORDER.indexOf(currentMode);
    let nextIndex: number | null = null;
    const rtl = shellRef.current ? getComputedStyle(shellRef.current).direction === 'rtl' : false;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + (rtl ? -1 : 1) + MODE_ORDER.length) % MODE_ORDER.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex + (rtl ? 1 : -1) + MODE_ORDER.length) % MODE_ORDER.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = MODE_ORDER.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextMode = MODE_ORDER[nextIndex];
    if (!nextMode) return;
    onModeChange(nextMode);
    modeTabRefs.current[nextMode]?.focus();
  }, [onModeChange]);

  // Only render inspector tabs that have content.
  const availableTabs = (Object.keys(INSPECTOR_TAB_LABELS) as InspectorTab[]).filter((t) => inspector[t] !== undefined);
  const currentTab = availableTabs.includes(activeTab) ? activeTab : availableTabs[0];

  const handleInspectorTabKeyDown = useCallback((event: KeyboardEvent, current: InspectorTab) => {
    const currentIndex = availableTabs.indexOf(current);
    let nextIndex: number | null = null;
    const rtl = shellRef.current ? getComputedStyle(shellRef.current).direction === 'rtl' : false;
    if (event.key === 'ArrowRight') nextIndex = (currentIndex + (rtl ? -1 : 1) + availableTabs.length) % availableTabs.length;
    if (event.key === 'ArrowLeft') nextIndex = (currentIndex + (rtl ? 1 : -1) + availableTabs.length) % availableTabs.length;
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = availableTabs.length - 1;
    if (nextIndex === null) return;
    event.preventDefault();
    const nextTab = availableTabs[nextIndex];
    if (!nextTab) return;
    setActiveTab(nextTab);
    inspectorTabRefs.current[nextTab]?.focus();
  }, [availableTabs]);

  const hasWorkspaceHeader = projectSwitcher || breadcrumbs || commandBar || importCreate;
  const hasOverlay = versionDiffReviewer || recycleRestore;

  const workspaceContent = splitPreview?.enabled ? (
    <SplitPreview
      primary={splitPreview.primary ?? children}
      secondary={splitPreview.secondary ?? null}
      orientation={splitPreview.orientation ?? 'horizontal'}
      split={splitPreview.split}
      onSplitChange={splitPreview.onSplitChange}
      primaryCollapsed={splitPreview.primaryCollapsed}
      onPrimaryCollapsedChange={splitPreview.onPrimaryCollapsedChange}
      secondaryCollapsed={splitPreview.secondaryCollapsed}
      onSecondaryCollapsedChange={splitPreview.onSecondaryCollapsedChange}
      syncScroll={splitPreview.syncScroll}
      onSyncScrollChange={splitPreview.onSyncScrollChange}
      responsiveBand={responsiveBand === 'narrow' ? 'narrow' : 'wide'}
    />
  ) : (
    children
  );

  return (
    <div className="project-shell-wrapper">
      {runTimeline && (
        <RunTimelineBanner
          runs={runTimeline.runs}
          isLoading={runTimeline.isLoading}
          error={runTimeline.error}
          onRetry={runTimeline.onRetry}
          onResume={runTimeline.onResume}
          onView={runTimeline.onView}
          onTerminate={runTimeline.onTerminate}
          onDismiss={runTimeline.onDismiss}
        />
      )}
      <div
        ref={shellRef}
        className={`project-shell ${leftCollapsed ? 'left-collapsed' : ''} ${rightCollapsed ? 'right-collapsed' : ''} ${leftOverlayOpen ? 'left-overlay-open' : ''} ${rightOverlayOpen ? 'right-overlay-open' : ''}`}
        role="region"
        aria-label="Metis 研究工作台"
        data-responsive-band={responsiveBand}
      >
        {overlaySide && (
          <button
            type="button"
            className="shell-overlay-backdrop"
            tabIndex={-1}
            aria-label={overlaySide === 'left' ? '关闭项目资料栏' : '关闭研究检查器'}
            onClick={() => closeOverlay()}
          />
        )}
        {/* ── Left: project + source tree ── */}
        <aside ref={leftAsideRef} className="shell-left" aria-label="项目与资料">
          <button
            ref={leftToggleRef}
            className="shell-collapse-btn shell-collapse-left"
            onClick={toggleLeft}
            aria-label={leftContentVisible ? '收起资料栏' : '展开资料栏'}
            aria-expanded={leftContentVisible}
            aria-controls={leftPanelId}
          >
            {leftContentVisible ? '«' : '»'}
          </button>
          {leftContentVisible && (
            <div
              ref={leftContentRef}
              id={leftPanelId}
              className="shell-left-content"
              tabIndex={leftOverlayOpen ? -1 : undefined}
              role={leftOverlayOpen ? 'dialog' : undefined}
              aria-modal={leftOverlayOpen ? true : undefined}
              aria-label={leftOverlayOpen ? '项目与资料' : undefined}
              onKeyDown={leftOverlayOpen ? (event) => handleOverlayKeyDown(event, 'left') : undefined}
            >
              {leftPanel}
            </div>
          )}
        </aside>

        {/* ── Center: workspace ── */}
        <section ref={centerRef} className="shell-center" aria-label="工作区">
          {hasWorkspaceHeader && (
            <div className="shell-workspace-header" data-responsive-band={responsiveBand}>
              {projectSwitcher && (
                <ProjectSwitcher
                  projects={projectSwitcher.projects}
                  activeProjectId={projectSwitcher.activeProjectId}
                  onSwitch={projectSwitcher.onSwitch}
                  loading={projectSwitcher.loading}
                  error={projectSwitcher.error}
                  onRefresh={projectSwitcher.onRefresh}
                  confirmSwitch
                />
              )}
              {breadcrumbs && (
                <Breadcrumbs
                  items={breadcrumbs}
                  onNavigate={onBreadcrumbNavigate}
                  size="sm"
                />
              )}
              {commandBar && (
                <button
                  type="button"
                  className="shell-command-bar-trigger"
                  onClick={commandBar.onOpen}
                  aria-label="打开命令面板"
                  title="命令面板 (Ctrl+K / ⌘+K)"
                >
                  <span className="shell-command-bar-trigger__label">命令</span>
                  <kbd className="shell-command-bar-trigger__shortcut">⌘K</kbd>
                </button>
              )}
              {importCreate && (
                <button
                  type="button"
                  className="shell-import-create-trigger"
                  onClick={importCreate.onOpen}
                  aria-label="导入或创建项目"
                  title="导入或创建项目"
                >
                  <span className="shell-import-create-trigger__label">导入/创建</span>
                </button>
              )}
            </div>
          )}
          {showModeSwitcher && (
            <div className="shell-mode-switcher" role="tablist" aria-label="工作模式">
              {MODE_ORDER.map((m) => (
                <button
                  key={m}
                  ref={(element) => { modeTabRefs.current[m] = element; }}
                  id={`${instanceId}-project-shell-mode-${m}`}
                  role="tab"
                  aria-selected={mode === m}
                  aria-controls={workspaceId}
                  tabIndex={mode === m ? 0 : -1}
                  className={`shell-mode-btn ${mode === m ? 'active' : ''}`}
                  onClick={() => onModeChange(m)}
                  onKeyDown={(event) => handleModeTabKeyDown(event, m)}
                >
                  {MODE_LABELS[m]}
                </button>
              ))}
            </div>
          )}
          {objectTabs && objectTabs.length > 0 && (
            <ObjectTabs
              tabs={objectTabs}
              activeId={activeObjectTabId}
              onSelect={onObjectTabSelect}
              onClose={onObjectTabClose}
              onNew={onObjectTabNew}
              onReorder={onObjectTabReorder}
            />
          )}
          <div
            id={workspaceId}
            className={`shell-workspace ${workspaceClassName}`.trim()}
            role="tabpanel"
            aria-label={`${MODE_LABELS[mode]}工作区`}
            aria-labelledby={showModeSwitcher ? `${instanceId}-project-shell-mode-${mode}` : undefined}
            data-responsive-band={responsiveBand}
          >
            {workspaceContent}
          </div>
          {selectionActionBar && selectionActionBar.selectedCount > 0 && (
            <SelectionActionBar
              selectedCount={selectionActionBar.selectedCount}
              selectedLabel={`已选择 ${selectionActionBar.selectedCount} 项`}
              onClearSelection={selectionActionBar.onClearSelection}
              onDeleteSelected={selectionActionBar.onDeleteSelected}
              onRestoreSelected={selectionActionBar.onRestoreSelected}
              onExportSelected={selectionActionBar.onExportSelected}
              extraActions={selectionActionBar.extraActions}
              loading={selectionActionBar.loading}
              error={selectionActionBar.error}
              onRetry={selectionActionBar.onRetry}
            />
          )}
        </section>

        {/* ── Right: inspector ── */}
        <aside ref={rightAsideRef} className="shell-right" aria-label="研究检查器">
          <button
            ref={rightToggleRef}
            className="shell-collapse-btn shell-collapse-right"
            onClick={toggleRight}
            aria-label={rightContentVisible ? '收起检查器' : '展开检查器'}
            aria-expanded={rightContentVisible}
            aria-controls={rightPanelId}
          >
            {rightContentVisible ? '»' : '«'}
          </button>
          {rightContentVisible && (
            <div
              ref={rightContentRef}
              id={rightPanelId}
              className="shell-right-content"
              tabIndex={rightOverlayOpen ? -1 : undefined}
              role={rightOverlayOpen ? 'dialog' : undefined}
              aria-modal={rightOverlayOpen ? true : undefined}
              aria-label={rightOverlayOpen ? '研究检查器' : undefined}
              onKeyDown={rightOverlayOpen ? (event) => handleOverlayKeyDown(event, 'right') : undefined}
            >
              {rightPanel ?? (
                <>
                  <div className="shell-inspector-tabs" role="tablist" aria-label="检查器视图">
                    {availableTabs.map((t) => (
                      <button
                        key={t}
                        ref={(element) => { inspectorTabRefs.current[t] = element; }}
                        id={`${instanceId}-project-shell-inspector-${t}`}
                        role="tab"
                        aria-selected={currentTab === t}
                        aria-controls={inspectorPanelId}
                        tabIndex={currentTab === t ? 0 : -1}
                        className={`shell-inspector-tab ${currentTab === t ? 'active' : ''}`}
                        onClick={() => setActiveTab(t)}
                        onKeyDown={(event) => handleInspectorTabKeyDown(event, t)}
                      >
                        {INSPECTOR_TAB_LABELS[t]}
                      </button>
                    ))}
                  </div>
                  <div
                    id={inspectorPanelId}
                    className="shell-inspector-body"
                    role="tabpanel"
                    aria-labelledby={currentTab ? `${instanceId}-project-shell-inspector-${currentTab}` : undefined}
                  >
                    {currentTab ? inspector[currentTab] : null}
                  </div>
                </>
              )}
            </div>
          )}
        </aside>

      </div>

      {/* KIMI-201: global overlays rendered outside the grid so they are not clipped. */}
      {commandBar && (
        <CommandBar
          isOpen={commandBar.isOpen}
          onClose={commandBar.onClose}
          commands={commandBar.commands}
          groups={commandBar.groups}
          loading={commandBar.loading}
          error={commandBar.error}
          onRetry={commandBar.onRetry}
          responsiveBand={responsiveBand}
        />
      )}
      {importCreate && (
        <ImportCreateDialog
          open={importCreate.isOpen}
          onClose={importCreate.onClose}
          onCreateProject={importCreate.onCreateProject}
          onImportFiles={importCreate.onImportFiles}
        />
      )}
      {hasOverlay && (
        <div className="shell-workspace-overlay" role="dialog" aria-modal="true" aria-label="工作区面板">
          {versionDiffReviewer && (
            <VersionDiffReviewer
              versions={versionDiffReviewer.versions}
              reviews={versionDiffReviewer.reviews}
              baseVersionId={versionDiffReviewer.baseVersionId}
              targetVersionId={versionDiffReviewer.targetVersionId}
              viewMode={versionDiffReviewer.viewMode}
              activeReviewId={versionDiffReviewer.activeReviewId}
              loading={versionDiffReviewer.loading}
              error={versionDiffReviewer.error}
              onRetry={versionDiffReviewer.onRetry}
              onBaseVersionChange={versionDiffReviewer.onBaseVersionChange}
              onTargetVersionChange={versionDiffReviewer.onTargetVersionChange}
              onViewModeChange={versionDiffReviewer.onViewModeChange}
              onReviewSelect={versionDiffReviewer.onReviewSelect}
              onResolveReview={versionDiffReviewer.onResolveReview}
              onAddReviewComment={versionDiffReviewer.onAddReviewComment}
              onApprove={versionDiffReviewer.onApprove}
              onReject={versionDiffReviewer.onReject}
              onRequestChanges={versionDiffReviewer.onRequestChanges}
            />
          )}
          {recycleRestore && (
            <RecycleRestore
              items={recycleRestore.items}
              loading={recycleRestore.loading}
              error={recycleRestore.error}
              recoveryMessage={recycleRestore.recoveryMessage}
              onDismissRecovery={recycleRestore.onDismissRecovery}
              onRefresh={recycleRestore.onRefresh}
              onRestore={recycleRestore.onRestore}
              onDeleteForever={recycleRestore.onDeleteForever}
            />
          )}
        </div>
      )}
    </div>
  );
}

export { MODE_LABELS, INSPECTOR_TAB_LABELS, MODE_ORDER };
