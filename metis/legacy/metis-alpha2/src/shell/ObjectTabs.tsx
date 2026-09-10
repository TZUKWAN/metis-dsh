/**
 * ObjectTabs — closable, scrollable, reorderable tab bar for research objects
 * (papers, notes, artifacts, etc.).
 *
 * Features:
 *   - Closable tabs with confirmation for dirty state
 *   - Horizontal scroll overflow with left/right arrow buttons
 *   - New-tab button via callback
 *   - Drag-and-drop reorder with placeholder indicator
 *   - Active-indicator bar (accent color)
 *   - Full keyboard navigation: ArrowLeft/Right, Home, End, Ctrl+W / Delete
 *   - RTL-aware (logical properties, direction in keyboard)
 *   - Container-responsive narrow band adaptation
 *   - forced-colors / prefers-reduced-motion media support
 *   - States: loading, empty, error (with retry), normal
 */

import {
  useState,
  useRef,
  useCallback,
  useEffect,
  useId,
  type ReactNode,
  type KeyboardEvent,
  type DragEvent,
} from 'react';
import {
  X,
  Plus,
  ChevronLeft,
  ChevronRight,
  Loader2,
  AlertTriangle,
} from 'lucide-react';
import './ObjectTabs.css';

/* ── Types ── */

export interface ObjectTab {
  id: string;
  label: string;
  /** Optional leading icon slot. */
  icon?: ReactNode;
  /** Whether the tab's associated content has unsaved changes. */
  dirty?: boolean;
  /** Whether the tab is in a loading state. */
  loading?: boolean;
  /** Error message for the tab, if any. */
  error?: string | null;
  /** Whether the tab is closable (defaults to true). */
  closable?: boolean;
}

export interface ObjectTabsProps {
  /** Ordered list of tabs to display. */
  tabs: ObjectTab[];
  /** Currently active tab id. */
  activeId?: string | null;
  /** Callback when a tab is selected. */
  onSelect?: (id: string) => void;
  /** Callback when a tab close is requested. Return false to prevent close. */
  onClose?: (id: string) => Promise<boolean | void> | boolean | void;
  /** Callback to create a new tab. */
  onNew?: () => void;
  /** Callback for drag reorder: (fromIndex, toIndex). */
  onReorder?: (fromIndex: number, toIndex: number) => void;
  /** Label for the new-tab button (defaults to "新建"). */
  newTabLabel?: string;
  /** Whether the entire tab bar is in a loading state. */
  loading?: boolean;
  /** Global error state for the tab bar. */
  error?: string | null;
  /** Retry callback for the error state. */
  onRetry?: () => void;
  /** Whether the tab bar is currently empty (for explicit empty state). */
  emptyLabel?: string;
  /** Label shown in the empty state. */
  emptyDescription?: string;
}

/* ── Constants ── */

const DEFAULT_NEW_TAB_LABEL = '新建';
const DEFAULT_EMPTY_LABEL = '暂无标签页';
const DEFAULT_EMPTY_DESCRIPTION = '点击右侧 + 按钮新建标签页';

/* ── Component ── */

export default function ObjectTabs({
  tabs,
  activeId,
  onSelect,
  onClose,
  onNew,
  onReorder,
  newTabLabel = DEFAULT_NEW_TAB_LABEL,
  loading = false,
  error = null,
  onRetry,
  emptyLabel = DEFAULT_EMPTY_LABEL,
  emptyDescription = DEFAULT_EMPTY_DESCRIPTION,
}: ObjectTabsProps) {
  const instanceId = useId();
  const scrollRef = useRef<HTMLDivElement>(null);
  const tabRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [showLeftArrow, setShowLeftArrow] = useState(false);
  const [showRightArrow, setShowRightArrow] = useState(false);
  const [dragOverIndex, setDragOverIndex] = useState<number | null>(null);
  const [dragFromIndex, setDragFromIndex] = useState<number | null>(null);
  const [closingIds, setClosingIds] = useState<Set<string>>(new Set());
  const [responsiveBand, setResponsiveBand] = useState<'wide' | 'narrow'>('wide');
  const containerRef = useRef<HTMLDivElement>(null);
  const bandRef = useRef(responsiveBand);

  /* ── Scroll arrow visibility ── */

  const updateScrollArrows = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const tolerance = 1;
    setShowLeftArrow(el.scrollLeft > tolerance);
    setShowRightArrow(el.scrollLeft + el.clientWidth < el.scrollWidth - tolerance);
  }, []);

  useEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    updateScrollArrows();
    el.addEventListener('scroll', updateScrollArrows, { passive: true });
    const ro = new ResizeObserver(updateScrollArrows);
    ro.observe(el);
    return () => {
      el.removeEventListener('scroll', updateScrollArrows);
      ro.disconnect();
    };
  }, [updateScrollArrows, tabs]);

  /* ── Responsive band detection ── */

  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const check = () => {
      if (!el) return;
      const w = el.clientWidth;
      const next = w <= 480 ? 'narrow' : 'wide';
      if (bandRef.current !== next) {
        bandRef.current = next;
        setResponsiveBand(next);
      }
    };
    check();
    const ro = new ResizeObserver(check);
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  /* ── Scroll by amount ── */

  const scrollBy = useCallback((direction: 'left' | 'right') => {
    const el = scrollRef.current;
    if (!el) return;
    const isRtl = getComputedStyle(el).direction === 'rtl';
    const amount = el.clientWidth * 0.6;
    el.scrollBy({
      left: (direction === 'left' ? -1 : 1) * (isRtl ? -amount : amount),
      behavior: 'instant',
    });
  }, []);

  /* ── Close handler ── */

  const handleClose = useCallback(async (id: string) => {
    if (!onClose || closingIds.has(id)) return;
    setClosingIds((prev) => new Set(prev).add(id));
    try {
      const result = await onClose(id);
      if (result === false) return;
    } finally {
      setClosingIds((prev) => {
        const next = new Set(prev);
        next.delete(id);
        return next;
      });
    }
  }, [onClose, closingIds]);

  /* ── Focus active tab ── */

  useEffect(() => {
    if (!activeId) return;
    const btn = tabRefs.current.get(activeId);
    if (btn && document.activeElement !== btn) {
      // Do not steal focus unless the tab bar is the focus source.
    }
  }, [activeId]);

  const focusTab = useCallback((id: string) => {
    const btn = tabRefs.current.get(id);
    btn?.focus();
  }, []);

  /* ── Keyboard navigation ── */

  const handleKeyDown = useCallback((event: KeyboardEvent<HTMLDivElement>) => {
    const currentIndex = activeId ? tabs.findIndex((t) => t.id === activeId) : -1;
    const count = tabs.length;
    if (count === 0) return;

    let nextIndex: number | null = null;
    if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
      const el = scrollRef.current;
      const isRtl = el ? getComputedStyle(el).direction === 'rtl' : false;
      const delta = (event.key === 'ArrowRight' ? 1 : -1) * (isRtl ? -1 : 1);
      nextIndex = ((currentIndex + delta) % count + count) % count;
    }
    if (event.key === 'Home') nextIndex = 0;
    if (event.key === 'End') nextIndex = count - 1;

    if (nextIndex !== null) {
      event.preventDefault();
      const tab = tabs[nextIndex];
      if (!tab) return;
      onSelect?.(tab.id);
      focusTab(tab.id);
      // Scroll into view
      const btn = tabRefs.current.get(tab.id);
      if (btn && typeof btn.scrollIntoView === 'function') {
        btn.scrollIntoView({ block: 'nearest', inline: 'nearest', behavior: 'instant' });
      }
      return;
    }

    // Close: Ctrl+W or Delete
    if (
      activeId &&
      (event.key === 'Delete' || (event.key === 'w' && (event.ctrlKey || event.metaKey)))
    ) {
      event.preventDefault();
      handleClose(activeId);
    }
  }, [tabs, activeId, onSelect, focusTab, handleClose]);

  /* ── Drag-and-drop ── */

  const handleDragStart = useCallback((event: DragEvent<HTMLButtonElement>, index: number) => {
    setDragFromIndex(index);
    event.dataTransfer.effectAllowed = 'move';
    event.dataTransfer.setData('text/plain', tabs[index]?.id ?? '');
  }, [tabs]);

  const handleDragOver = useCallback((event: DragEvent<HTMLButtonElement>, index: number) => {
    event.preventDefault();
    event.dataTransfer.dropEffect = 'move';
    setDragOverIndex(index);
  }, []);

  const handleDragLeave = useCallback(() => {
    setDragOverIndex(null);
  }, []);

  const handleDrop = useCallback((event: DragEvent<HTMLButtonElement>, toIndex: number) => {
    event.preventDefault();
    const fromIndex = dragFromIndex;
    setDragOverIndex(null);
    setDragFromIndex(null);
    if (fromIndex === null || fromIndex === toIndex) return;
    onReorder?.(fromIndex, toIndex);
  }, [dragFromIndex, onReorder]);

  const handleDragEnd = useCallback(() => {
    setDragOverIndex(null);
    setDragFromIndex(null);
  }, []);

  /* ── Render: error state ── */

  if (error) {
    return (
      <div
        ref={containerRef}
        className="object-tabs object-tabs--error"
        role="tablist"
        aria-label="对象标签页"
        data-responsive-band={responsiveBand}
      >
        <div className="object-tabs__error">
          <AlertTriangle size={14} aria-hidden="true" />
          <span>{error}</span>
          {onRetry && (
            <button
              type="button"
              className="object-tabs__retry-btn"
              onClick={onRetry}
            >
              重试
            </button>
          )}
        </div>
      </div>
    );
  }

  /* ── Render: loading state ── */

  if (loading) {
    return (
      <div
        ref={containerRef}
        className="object-tabs object-tabs--loading"
        role="tablist"
        aria-label="对象标签页"
        aria-busy="true"
        data-responsive-band={responsiveBand}
      >
        <div className="object-tabs__loading">
          <Loader2 size={14} className="object-tabs__spinner" aria-hidden="true" />
          <span>加载中…</span>
        </div>
      </div>
    );
  }

  /* ── Render: empty state ── */

  if (tabs.length === 0) {
    return (
      <div
        ref={containerRef}
        className="object-tabs object-tabs--empty"
        role="tablist"
        aria-label="对象标签页"
        data-responsive-band={responsiveBand}
      >
        <span className="object-tabs__empty-label">{emptyLabel}</span>
        <span className="object-tabs__empty-desc">{emptyDescription}</span>
        {onNew && (
          <button
            type="button"
            className="object-tabs__new-btn object-tabs__new-btn--empty"
            onClick={onNew}
            aria-label={newTabLabel}
          >
            <Plus size={14} aria-hidden="true" />
            <span>{newTabLabel}</span>
          </button>
        )}
      </div>
    );
  }

  /* ── Render: normal ── */

  return (
    <div
      ref={containerRef}
      className="object-tabs"
      role="tablist"
      aria-label="对象标签页"
      data-responsive-band={responsiveBand}
      onKeyDown={handleKeyDown}
    >
      {/* Left scroll arrow */}
      {showLeftArrow && (
        <button
          type="button"
          className="object-tabs__scroll-arrow object-tabs__scroll-arrow--left"
          onClick={() => scrollBy('left')}
          aria-label="向左滚动标签页"
          tabIndex={-1}
        >
          <ChevronLeft size={14} aria-hidden="true" />
        </button>
      )}

      {/* Tab strip */}
      <div ref={scrollRef} className="object-tabs__strip">
        {/* Drop placeholder before first tab */}
        {dragOverIndex === 0 && dragFromIndex !== 0 && (
          <div className="object-tabs__drop-placeholder" aria-hidden="true" />
        )}

        {tabs.map((tab, index) => {
          const isActive = tab.id === activeId;
          const isClosing = closingIds.has(tab.id);
          const isClosable = tab.closable !== false;

          return (
            <div key={tab.id} className="object-tabs__tab-wrapper">
              {/* Drop placeholder before this tab */}
              {dragOverIndex === index && dragFromIndex !== index && dragFromIndex !== index - 1 && (
                <div className="object-tabs__drop-placeholder" aria-hidden="true" />
              )}

              <button
                ref={(el) => {
                  if (el) tabRefs.current.set(tab.id, el);
                  else tabRefs.current.delete(tab.id);
                }}
                id={`${instanceId}-tab-${tab.id}`}
                role="tab"
                aria-selected={isActive}
                aria-label={`${tab.label}${tab.dirty ? '（未保存）' : ''}${tab.error ? `（错误：${tab.error}）` : ''}`}
                tabIndex={isActive ? 0 : -1}
                className={`object-tabs__tab${isActive ? ' object-tabs__tab--active' : ''}${tab.dirty ? ' object-tabs__tab--dirty' : ''}${tab.error ? ' object-tabs__tab--error' : ''}${isClosing ? ' object-tabs__tab--closing' : ''}`}
                onClick={() => onSelect?.(tab.id)}
                draggable={!!onReorder}
                onDragStart={onReorder ? (e) => handleDragStart(e, index) : undefined}
                onDragOver={onReorder ? (e) => handleDragOver(e, index) : undefined}
                onDragLeave={onReorder ? handleDragLeave : undefined}
                onDrop={onReorder ? (e) => handleDrop(e, index) : undefined}
                onDragEnd={onReorder ? handleDragEnd : undefined}
                disabled={isClosing}
              >
                {/* Loading spinner */}
                {tab.loading && (
                  <Loader2
                    size={12}
                    className="object-tabs__tab-spinner"
                    aria-label="加载中"
                  />
                )}

                {/* Error indicator */}
                {!tab.loading && tab.error && (
                  <AlertTriangle
                    size={12}
                    className="object-tabs__tab-error-icon"
                    aria-label={`错误：${tab.error}`}
                  />
                )}

                {/* Custom icon */}
                {!tab.loading && !tab.error && tab.icon && (
                  <span className="object-tabs__tab-icon" aria-hidden="true">
                    {tab.icon}
                  </span>
                )}

                {/* Label */}
                <span className="object-tabs__tab-label">{tab.label}</span>

                {/* Dirty indicator */}
                {tab.dirty && !tab.loading && (
                  <span className="object-tabs__tab-dirty-dot" aria-hidden="true" />
                )}

                {/* Close button */}
                {isClosable && (
                  <span
                    role="button"
                    tabIndex={0}
                    className="object-tabs__tab-close"
                    aria-label={`关闭${tab.label}`}
                    onClick={(e) => {
                      e.stopPropagation();
                      handleClose(tab.id);
                    }}
                    onKeyDown={(e) => {
                      if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        e.stopPropagation();
                        handleClose(tab.id);
                      }
                    }}
                  >
                    <X size={12} aria-hidden="true" />
                  </span>
                )}
              </button>
            </div>
          );
        })}

        {/* Drop placeholder after last tab */}
        {dragOverIndex === tabs.length && dragFromIndex !== tabs.length - 1 && (
          <div className="object-tabs__drop-placeholder" aria-hidden="true" />
        )}
      </div>

      {/* Right scroll arrow */}
      {showRightArrow && (
        <button
          type="button"
          className="object-tabs__scroll-arrow object-tabs__scroll-arrow--right"
          onClick={() => scrollBy('right')}
          aria-label="向右滚动标签页"
          tabIndex={-1}
        >
          <ChevronRight size={14} aria-hidden="true" />
        </button>
      )}

      {/* Shadow overlay when scrolled — left fade */}
      {showLeftArrow && (
        <div className="object-tabs__fade object-tabs__fade--left" aria-hidden="true" />
      )}

      {/* Shadow overlay when scrolled — right fade */}
      {showRightArrow && (
        <div
          className={`object-tabs__fade object-tabs__fade--right${onNew ? ' object-tabs__fade--with-new' : ''}`}
          aria-hidden="true"
        />
      )}

      {/* New tab button */}
      {onNew && (
        <button
          type="button"
          className="object-tabs__new-btn"
          onClick={onNew}
          aria-label={newTabLabel}
          tabIndex={-1}
        >
          <Plus size={14} aria-hidden="true" />
          {responsiveBand === 'wide' && <span>{newTabLabel}</span>}
        </button>
      )}
    </div>
  );
}
