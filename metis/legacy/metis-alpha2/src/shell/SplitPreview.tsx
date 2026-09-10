/**
 * SplitPreview — resizable two-pane preview panel for the research workbench.
 *
 * Features:
 *   - Draggable sash to adjust the split ratio (horizontal or vertical)
 *   - Collapse/expand either pane independently
 *   - Optional synchronized scrolling between the two panes
 *   - Narrow-screen auto-stack via data-responsive-band
 *   - Full keyboard control of the sash (arrows, Home/End, PageUp/PageDown)
 *   - RTL-aware drag and keyboard navigation
 *   - Loading, empty, and error/recovery states
 *   - Supports 200% zoom, forced-colors mode, and prefers-reduced-motion
 *
 * All backend-dependent actions are exposed as prop callbacks; no results are faked.
 */

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
} from 'react';
import {
  PanelLeft,
  PanelRight,
  PanelTop,
  PanelBottom,
  Lock,
  Unlock,
  Loader2,
  AlertCircle,
  RefreshCw,
  Columns2,
  Rows2,
} from 'lucide-react';
import './SplitPreview.css';

export interface SplitPreviewProps {
  /** Content for the primary pane (left when horizontal, top when vertical). */
  primary?: ReactNode;
  /** Content for the secondary pane (right when horizontal, bottom when vertical). */
  secondary?: ReactNode;
  /** Layout direction. */
  orientation?: 'horizontal' | 'vertical';
  /** Accessible label for the primary pane. */
  primaryLabel?: string;
  /** Accessible label for the secondary pane. */
  secondaryLabel?: string;
  /**
   * Split ratio as a percentage of the primary pane size (0–100).
   * Provide this plus onSplitChange for controlled usage.
   */
  split?: number;
  /** Default split ratio for uncontrolled usage. */
  defaultSplit?: number;
  /** Called when the user changes the split ratio. */
  onSplitChange?: (split: number) => void;
  /** Minimum allowed split percentage. */
  minSplit?: number;
  /** Maximum allowed split percentage. */
  maxSplit?: number;
  /** Controlled collapse state for the primary pane. */
  primaryCollapsed?: boolean;
  /** Controlled collapse state for the secondary pane. */
  secondaryCollapsed?: boolean;
  /** Called when the primary pane collapse state changes. */
  onPrimaryCollapsedChange?: (collapsed: boolean) => void;
  /** Called when the secondary pane collapse state changes. */
  onSecondaryCollapsedChange?: (collapsed: boolean) => void;
  /** Controlled synchronized-scroll state. */
  syncScroll?: boolean;
  /** Called when the user toggles synchronized scrolling. */
  onSyncScrollChange?: (sync: boolean) => void;
  /** Show a global loading overlay. */
  loading?: boolean;
  /** Error message to display with an optional retry action. */
  error?: string | null;
  /** Retry callback; shown when error is provided. */
  onRetry?: () => void;
  /** Responsive band override. Falls back to container width detection. */
  responsiveBand?: 'wide' | 'narrow';
  /** Extra class names for the root element. */
  className?: string;
}

const NARROW_BREAKPOINT = 480;
const KEYBOARD_STEP = 1;
const KEYBOARD_PAGE_STEP = 10;

function clamp(value: number, min: number, max: number): number {
  return Math.max(min, Math.min(max, value));
}

export default function SplitPreview({
  primary,
  secondary,
  orientation = 'horizontal',
  primaryLabel = '主面板',
  secondaryLabel = '次面板',
  split: controlledSplit,
  defaultSplit = 50,
  onSplitChange,
  minSplit = 20,
  maxSplit = 80,
  primaryCollapsed: controlledPrimaryCollapsed,
  secondaryCollapsed: controlledSecondaryCollapsed,
  onPrimaryCollapsedChange,
  onSecondaryCollapsedChange,
  syncScroll: controlledSyncScroll,
  onSyncScrollChange,
  loading = false,
  error = null,
  onRetry,
  responsiveBand: responsiveBandOverride,
  className = '',
}: SplitPreviewProps) {
  const rootRef = useRef<HTMLDivElement>(null);
  const sashRef = useRef<HTMLDivElement>(null);
  const primaryRef = useRef<HTMLDivElement>(null);
  const secondaryRef = useRef<HTMLDivElement>(null);
  const primaryScrollRef = useRef<HTMLDivElement>(null);
  const secondaryScrollRef = useRef<HTMLDivElement>(null);

  const [uncontrolledSplit, setUncontrolledSplit] = useState(clamp(defaultSplit, minSplit, maxSplit));
  const [uncontrolledPrimaryCollapsed, setUncontrolledPrimaryCollapsed] = useState(false);
  const [uncontrolledSecondaryCollapsed, setUncontrolledSecondaryCollapsed] = useState(false);
  const [uncontrolledSyncScroll, setUncontrolledSyncScroll] = useState(false);
  const [detectedBand, setDetectedBand] = useState<'wide' | 'narrow'>('wide');
  const [dragging, setDragging] = useState(false);
  const [announcement, setAnnouncement] = useState<string | null>(null);

  const split = controlledSplit ?? uncontrolledSplit;
  const liveSplitRef = useRef(split);

  useEffect(() => {
    liveSplitRef.current = split;
  }, [split]);

  const primaryCollapsed = controlledPrimaryCollapsed ?? uncontrolledPrimaryCollapsed;
  const secondaryCollapsed = controlledSecondaryCollapsed ?? uncontrolledSecondaryCollapsed;
  const syncScroll = controlledSyncScroll ?? uncontrolledSyncScroll;

  const isHorizontal = orientation === 'horizontal';
  const primaryVisible = !primaryCollapsed;
  const secondaryVisible = !secondaryCollapsed;
  const eitherCollapsed = primaryCollapsed || secondaryCollapsed;

  // ── Responsive band detection ──
  const resolvedBand = responsiveBandOverride ?? detectedBand;

  useEffect(() => {
    if (responsiveBandOverride) return;
    const root = rootRef.current;
    if (!root) return;

    const updateBand = () => {
      const rect = root.getBoundingClientRect();
      const narrow = isHorizontal ? rect.width < NARROW_BREAKPOINT : rect.height < NARROW_BREAKPOINT;
      setDetectedBand(narrow ? 'narrow' : 'wide');
    };

    updateBand();
    const observer = new ResizeObserver(updateBand);
    observer.observe(root);
    return () => observer.disconnect();
  }, [isHorizontal, responsiveBandOverride]);

  // ── Split change helpers ──
  const setSplit = useCallback(
    (next: number) => {
      const clamped = clamp(next, minSplit, maxSplit);
      if (controlledSplit === undefined) setUncontrolledSplit(clamped);
      onSplitChange?.(clamped);
    },
    [controlledSplit, maxSplit, minSplit, onSplitChange],
  );

  const togglePrimaryCollapsed = useCallback(() => {
    const next = !primaryCollapsed;
    if (controlledPrimaryCollapsed === undefined) setUncontrolledPrimaryCollapsed(next);
    onPrimaryCollapsedChange?.(next);
  }, [controlledPrimaryCollapsed, onPrimaryCollapsedChange, primaryCollapsed]);

  const toggleSecondaryCollapsed = useCallback(() => {
    const next = !secondaryCollapsed;
    if (controlledSecondaryCollapsed === undefined) setUncontrolledSecondaryCollapsed(next);
    onSecondaryCollapsedChange?.(next);
  }, [controlledSecondaryCollapsed, onSecondaryCollapsedChange, secondaryCollapsed]);

  const toggleSyncScroll = useCallback(() => {
    const next = !syncScroll;
    if (controlledSyncScroll === undefined) setUncontrolledSyncScroll(next);
    onSyncScrollChange?.(next);
  }, [controlledSyncScroll, onSyncScrollChange, syncScroll]);

  // ── Drag handling ──
  const handlePointerDown = useCallback(
    (event: PointerEvent<HTMLDivElement>) => {
      if (event.button !== 0) return;
      event.preventDefault();
      const sash = sashRef.current;
      const root = rootRef.current;
      if (!sash || !root) return;

      sash.setPointerCapture(event.pointerId);
      setDragging(true);
      const start = isHorizontal ? event.clientX : event.clientY;
      const rect = root.getBoundingClientRect();
      const total = isHorizontal ? rect.width : rect.height;
      const rtl = getComputedStyle(root).direction === 'rtl';
      const startSplit = split;

      const handlePointerMove = (moveEvent: globalThis.PointerEvent) => {
        const current = isHorizontal ? moveEvent.clientX : moveEvent.clientY;
        let delta = current - start;
        if (isHorizontal && rtl) delta = -delta;
        const ratioDelta = total > 0 ? (delta / total) * 100 : 0;
        const next = clamp(startSplit + ratioDelta, minSplit, maxSplit);
        liveSplitRef.current = next;
        setSplit(next);
      };

      const handlePointerUp = (upEvent: globalThis.PointerEvent) => {
        sash.releasePointerCapture(upEvent.pointerId);
        setDragging(false);
        setAnnouncement(`分割比例已调整为 ${Math.round(liveSplitRef.current)}%`);
        window.removeEventListener('pointermove', handlePointerMove);
        window.removeEventListener('pointerup', handlePointerUp);
      };

      window.addEventListener('pointermove', handlePointerMove);
      window.addEventListener('pointerup', handlePointerUp);
    },
    [isHorizontal, maxSplit, minSplit, setSplit, split],
  );

  // ── Keyboard adjustment ──
  const handleSashKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const root = rootRef.current;
      const rtl = root ? getComputedStyle(root).direction === 'rtl' : false;
      let handled = true;

      switch (event.key) {
        case 'ArrowRight':
          setSplit(split + (isHorizontal ? (rtl ? -KEYBOARD_STEP : KEYBOARD_STEP) : 0));
          break;
        case 'ArrowLeft':
          setSplit(split + (isHorizontal ? (rtl ? KEYBOARD_STEP : -KEYBOARD_STEP) : 0));
          break;
        case 'ArrowDown':
          setSplit(split + (isHorizontal ? 0 : KEYBOARD_STEP));
          break;
        case 'ArrowUp':
          setSplit(split + (isHorizontal ? 0 : -KEYBOARD_STEP));
          break;
        case 'PageDown':
          setSplit(split + KEYBOARD_PAGE_STEP);
          break;
        case 'PageUp':
          setSplit(split - KEYBOARD_PAGE_STEP);
          break;
        case 'Home':
          setSplit(minSplit);
          break;
        case 'End':
          setSplit(maxSplit);
          break;
        default:
          handled = false;
      }

      if (handled) {
        event.preventDefault();
        setAnnouncement(`分割比例已调整为 ${Math.round(split)}%`);
      }
    },
    [isHorizontal, maxSplit, minSplit, setSplit, split],
  );

  // ── Synchronized scrolling ──
  const syncingRef = useRef(false);
  useEffect(() => {
    const primaryScroller = primaryScrollRef.current;
    const secondaryScroller = secondaryScrollRef.current;
    if (!primaryScroller || !secondaryScroller || !syncScroll) return;

    const sync = (
      source: HTMLElement,
      target: HTMLElement,
      axis: 'scrollTop' | 'scrollLeft',
    ) => {
      if (syncingRef.current) return;
      syncingRef.current = true;
      target[axis] = source[axis];
      requestAnimationFrame(() => {
        syncingRef.current = false;
      });
    };

    const axis = isHorizontal ? 'scrollTop' : 'scrollLeft';

    const handlePrimaryScroll: EventListener = (event) => {
      const target = event.currentTarget;
      if (target instanceof HTMLElement) {
        sync(target, secondaryScroller, axis);
      }
    };
    const handleSecondaryScroll: EventListener = (event) => {
      const target = event.currentTarget;
      if (target instanceof HTMLElement) {
        sync(target, primaryScroller, axis);
      }
    };

    primaryScroller.addEventListener('scroll', handlePrimaryScroll);
    secondaryScroller.addEventListener('scroll', handleSecondaryScroll);
    return () => {
      primaryScroller.removeEventListener('scroll', handlePrimaryScroll);
      secondaryScroller.removeEventListener('scroll', handleSecondaryScroll);
    };
  }, [isHorizontal, syncScroll]);

  // ── Render helpers ──
  const renderEmpty = (label: string) => (
    <div className="split-preview__empty" role="status" aria-live="polite">
      <PanelLeft size={20} aria-hidden="true" className="split-preview__empty-icon" />
      <span className="split-preview__empty-text">{label} 暂无内容</span>
    </div>
  );

  const paneClass = (side: 'primary' | 'secondary') =>
    `split-preview__pane split-preview__pane--${side} ${
      side === 'primary' ? (primaryVisible ? '' : 'is-collapsed') : secondaryVisible ? '' : 'is-collapsed'
    }`;

  const toolbarLabel = `${isHorizontal ? '左右' : '上下'}分栏预览工具栏`;
  const sashOrientation = isHorizontal ? 'vertical' : 'horizontal';
  const sashLabel = `调整${isHorizontal ? '左右' : '上下'}面板大小，当前主面板占 ${Math.round(split)}%`;

  return (
    <div
      ref={rootRef}
      className={`split-preview split-preview--${orientation} ${eitherCollapsed ? 'has-collapsed' : ''} ${dragging ? 'is-dragging' : ''} ${className}`.trim()}
      data-responsive-band={resolvedBand}
      data-primary-collapsed={primaryCollapsed}
      data-secondary-collapsed={secondaryCollapsed}
      role="region"
      aria-label="分栏预览"
    >
      {/* ── Error/recovery state ── */}
      {error && (
        <div className="split-preview__error" role="alert">
          <AlertCircle size={16} aria-hidden="true" className="split-preview__error-icon" />
          <span className="split-preview__error-text">{error}</span>
          {onRetry && (
            <button
              type="button"
              className="split-preview__retry-btn"
              onClick={onRetry}
              aria-label="重试"
            >
              <RefreshCw size={13} aria-hidden="true" />
              <span>重试</span>
            </button>
          )}
        </div>
      )}

      {/* ── Toolbar ── */}
      <div className="split-preview__toolbar" role="toolbar" aria-label={toolbarLabel}>
        <div className="split-preview__toolbar-group" role="group" aria-label="面板控制">
          <button
            type="button"
            className={`split-preview__toolbar-btn ${primaryCollapsed ? 'is-active' : ''}`}
            onClick={togglePrimaryCollapsed}
            aria-pressed={primaryCollapsed}
            aria-label={primaryCollapsed ? `展开${primaryLabel}` : `折叠${primaryLabel}`}
            title={primaryCollapsed ? `展开${primaryLabel}` : `折叠${primaryLabel}`}
          >
            {isHorizontal ? (
              <PanelLeft size={15} aria-hidden="true" />
            ) : (
              <PanelTop size={15} aria-hidden="true" />
            )}
            <span className="split-preview__toolbar-text">
              {primaryCollapsed ? '展开' : '折叠'}
            </span>
          </button>

          <button
            type="button"
            className={`split-preview__toolbar-btn ${syncScroll ? 'is-active' : ''}`}
            onClick={toggleSyncScroll}
            aria-pressed={syncScroll}
            aria-label={syncScroll ? '关闭同步滚动' : '开启同步滚动'}
            title={syncScroll ? '关闭同步滚动' : '开启同步滚动'}
          >
            {syncScroll ? (
              <Lock size={15} aria-hidden="true" />
            ) : (
              <Unlock size={15} aria-hidden="true" />
            )}
            <span className="split-preview__toolbar-text">同步滚动</span>
          </button>

          <button
            type="button"
            className={`split-preview__toolbar-btn ${secondaryCollapsed ? 'is-active' : ''}`}
            onClick={toggleSecondaryCollapsed}
            aria-pressed={secondaryCollapsed}
            aria-label={secondaryCollapsed ? `展开${secondaryLabel}` : `折叠${secondaryLabel}`}
            title={secondaryCollapsed ? `展开${secondaryLabel}` : `折叠${secondaryLabel}`}
          >
            {isHorizontal ? (
              <PanelRight size={15} aria-hidden="true" />
            ) : (
              <PanelBottom size={15} aria-hidden="true" />
            )}
            <span className="split-preview__toolbar-text">
              {secondaryCollapsed ? '展开' : '折叠'}
            </span>
          </button>
        </div>

        <div className="split-preview__split-badge" aria-live="polite" aria-atomic="true">
          {isHorizontal ? <Columns2 size={13} aria-hidden="true" /> : <Rows2 size={13} aria-hidden="true" />}
          <span>{Math.round(split)}%</span>
        </div>
      </div>

      {/* ── Panes ── */}
      <div className="split-preview__body">
        <div
          ref={primaryRef}
          className={paneClass('primary')}
          aria-label={primaryLabel}
          style={
            resolvedBand === 'narrow' || primaryCollapsed
              ? undefined
              : { flexBasis: `${split}%` }
          }
        >
          <div
            ref={primaryScrollRef}
            className="split-preview__scroll"
            tabIndex={0}
            role="region"
            aria-label={`${primaryLabel}滚动区域`}
          >
            {loading ? (
              <div className="split-preview__loading" role="status" aria-live="polite">
                <Loader2 size={22} aria-hidden="true" className="split-preview__spinner" />
                <span>加载中…</span>
              </div>
            ) : primary ? (
              primary
            ) : (
              renderEmpty(primaryLabel)
            )}
          </div>
        </div>

        {!eitherCollapsed && resolvedBand === 'wide' && (
          <div
            ref={sashRef}
            className="split-preview__sash"
            role="separator"
            aria-orientation={sashOrientation}
            aria-valuenow={Math.round(split)}
            aria-valuemin={minSplit}
            aria-valuemax={maxSplit}
            aria-label={sashLabel}
            tabIndex={0}
            onPointerDown={handlePointerDown}
            onKeyDown={handleSashKeyDown}
          >
            <div className="split-preview__sash-handle" aria-hidden="true" />
          </div>
        )}

        <div
          ref={secondaryRef}
          className={paneClass('secondary')}
          aria-label={secondaryLabel}
        >
          <div
            ref={secondaryScrollRef}
            className="split-preview__scroll"
            tabIndex={0}
            role="region"
            aria-label={`${secondaryLabel}滚动区域`}
          >
            {secondary ? secondary : renderEmpty(secondaryLabel)}
          </div>
        </div>
      </div>

      {/* ── Screen-reader announcements ── */}
      {announcement && (
        <div className="split-preview__sr-only" role="status" aria-live="polite" aria-atomic="true">
          {announcement}
        </div>
      )}
    </div>
  );
}

export {
  PanelLeft,
  PanelRight,
  PanelTop,
  PanelBottom,
  Lock,
  Unlock,
  Loader2,
  AlertCircle,
  RefreshCw,
  Columns2,
  Rows2,
};
