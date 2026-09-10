/**
 * SelectionActionBar — bottom-fixed selection toolbar for batch operations.
 *
 * Features:
 *   - Selection count display (with checkmark icon)
 *   - Batch-action buttons: delete, restore, export
 *   - Clear selection shortcut
 *   - Expandable "more actions" dropdown for extra/custom actions
 *   - Loading state per-action or global
 *   - Error display with retry
 *   - Full keyboard navigation (arrow keys, Escape to clear, Enter/Space to trigger)
 *   - Slide-up enter animation, respects prefers-reduced-motion
 *   - RTL support via logical CSS properties
 *   - Forced-colors mode support
 *   - data-responsive-band for narrow-screen stacking
 *
 * All backend-dependent actions are exposed as props callbacks — no mock data or fake results.
 */

import {
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { Check, Trash2, RotateCcw, Download, X, ChevronUp, RefreshCw, MoreHorizontal } from 'lucide-react';
import './SelectionActionBar.css';

export interface ExtraAction {
  /** Unique identifier for the action. */
  id: string;
  /** Display label for the action button. */
  label: string;
  /** Icon node for the action. */
  icon?: ReactNode;
  /** Action handler: sync or async. */
  onClick: () => void | Promise<void>;
  /** Disable this specific action. */
  disabled?: boolean;
  /** Show a loading spinner on this action. */
  loading?: boolean;
  /** Danger styling for destructive extra actions. */
  danger?: boolean;
}

export interface SelectionActionBarProps {
  /** Number of currently selected items. 0 means the bar is hidden. */
  selectedCount: number;
  /** Optional list of selected IDs for aria-label construction. */
  selectedLabel?: string;
  /**
   * Callback to delete selected items.
   * Async: the button shows a spinner until the promise resolves.
   * Not provided → button is hidden.
   */
  onDeleteSelected?: () => void | Promise<void>;
  /**
   * Callback to restore selected items (e.g. from trash).
   * Not provided → button is hidden.
   */
  onRestoreSelected?: () => void | Promise<void>;
  /**
   * Callback to export selected items.
   * Not provided → button is hidden.
   */
  onExportSelected?: () => void | Promise<void>;
  /** Clear the current selection (Escape key also triggers this). */
  onClearSelection?: () => void;
  /** Extra actions surfaced in the "more" dropdown menu. */
  extraActions?: ExtraAction[];
  /** Global loading state: disables all action buttons. */
  loading?: boolean;
  /** Error message to display in the bar. Dismissed when cleared. */
  error?: string | null;
  /** Retry callback shown next to the error message. */
  onRetry?: () => void;
  /** Label text for the items being selected (e.g. "笔记", "文献"). */
  itemLabel?: string;
  /** Toolbar accessible label. */
  ariaLabel?: string;
  /** Responsive band override. Falls back to parent's data-responsive-band. */
  responsiveBand?: 'wide' | 'narrow';
}

/** Focusable elements within the bar, in DOM order. */
const FOCUSABLE_SELECTOR =
  'button:not([disabled]):not([tabindex="-1"]), [tabindex]:not([tabindex="-1"])';

function getFocusable(container: HTMLElement): HTMLElement[] {
  return Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)).filter(
    (el) => !el.hidden && !el.closest('[inert]'),
  );
}

export default function SelectionActionBar({
  selectedCount,
  selectedLabel,
  onDeleteSelected,
  onRestoreSelected,
  onExportSelected,
  onClearSelection,
  extraActions,
  loading = false,
  error = null,
  onRetry,
  itemLabel = '项',
  ariaLabel,
  responsiveBand: responsiveBandOverride,
}: SelectionActionBarProps) {
  const barRef = useRef<HTMLDivElement>(null);
  const moreBtnRef = useRef<HTMLButtonElement>(null);
  const moreMenuRef = useRef<HTMLDivElement>(null);

  // Track per-action loading to show spinner on the triggered button.
  const [actionLoading, setActionLoading] = useState<Set<string>>(new Set());
  const [actionError, setActionError] = useState<string | null>(null);
  const [moreOpen, setMoreOpen] = useState(false);
  const [moreMenuFocusIndex, setMoreMenuFocusIndex] = useState(0);
  const [detectedBand, setDetectedBand] = useState<'wide' | 'narrow'>('wide');
  const lastActionRef = useRef<{ key: string; action: () => void | Promise<void> } | null>(null);

  // If selectedCount is 0, hide the entire bar.
  const visible = selectedCount > 0;

  const actionLabel = selectedLabel ?? `${selectedCount} 个${itemLabel}`;
  const toolbarLabel =
    ariaLabel ?? `已选择 ${selectedCount} 个${itemLabel} — 批量操作工具栏`;

  // ── Responsive band detection ──
  const resolvedBand = responsiveBandOverride ?? detectedBand;

  useEffect(() => {
    if (responsiveBandOverride) return;
    const bar = barRef.current;
    if (!bar) return;
    // Walk up the tree to find [data-responsive-band].
    let parent: HTMLElement | null = bar.parentElement;
    while (parent) {
      const band = parent.getAttribute('data-responsive-band');
      if (band === 'narrow' || band === 'medium' || band === 'wide') {
        setDetectedBand(band === 'wide' ? 'wide' : 'narrow');
        return;
      }
      parent = parent.parentElement;
    }
    // Fallback: use ResizeObserver to decide.
    const check = () => {
      if (bar && bar.offsetWidth < 480) {
        setDetectedBand('narrow');
      } else {
        setDetectedBand('wide');
      }
    };
    check();
    const observer = new ResizeObserver(check);
    observer.observe(bar);
    return () => observer.disconnect();
  }, [responsiveBandOverride]);

  // ── Close "more" menu on outside click ──
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (event: MouseEvent) => {
      if (
        moreMenuRef.current &&
        !moreMenuRef.current.contains(event.target as Node) &&
        moreBtnRef.current &&
        !moreBtnRef.current.contains(event.target as Node)
      ) {
        setMoreOpen(false);
      }
    };
    window.addEventListener('mousedown', handler, true);
    return () => window.removeEventListener('mousedown', handler, true);
  }, [moreOpen]);

  // ── Close "more" menu on Escape ──
  useEffect(() => {
    if (!moreOpen) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        setMoreOpen(false);
        moreBtnRef.current?.focus();
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [moreOpen]);

  const toggleMoreMenu = useCallback(() => {
    setMoreOpen((prev) => {
      const next = !prev;
      if (next) setMoreMenuFocusIndex(0);
      return next;
    });
  }, []);

  // ── Action runner: tracks loading per-action, captures sync throw and thenable reject ──
  const clearLoading = useCallback((actionKey: string) => {
    setActionLoading((prev) => {
      const next = new Set(prev);
      next.delete(actionKey);
      return next;
    });
  }, []);

  const runAction = useCallback(
    (actionKey: string, action?: () => void | Promise<void>) => {
      if (!action || loading) return;
      lastActionRef.current = { key: actionKey, action };
      setActionLoading((prev) => new Set(prev).add(actionKey));
      setActionError(null);
      try {
        const result = action();
        Promise.resolve(result)
          .then(() => {
            setActionError(null);
          })
          .catch((err: unknown) => {
            setActionError(
              err instanceof Error ? err.message : typeof err === 'string' ? err : '操作失败',
            );
          })
          .then(() => {
            clearLoading(actionKey);
          });
      } catch (err) {
        setActionError(
          err instanceof Error ? err.message : typeof err === 'string' ? err : '操作失败',
        );
        clearLoading(actionKey);
      }
    },
    [clearLoading, loading],
  );

  const isLoading = (key: string) => actionLoading.has(key) || loading;

  const displayedError = actionError ?? error;

  const handleRetry = useCallback(() => {
    if (actionError && lastActionRef.current) {
      const { key, action } = lastActionRef.current;
      runAction(key, action);
    } else {
      onRetry?.();
    }
  }, [actionError, onRetry, runAction]);

  // ── Keyboard: toolbar-level arrow navigation ──
  const handleToolbarKeyDown = useCallback(
    (event: KeyboardEvent) => {
      const bar = barRef.current;
      if (!bar) return;

      // Escape clears selection.
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        onClearSelection?.();
        return;
      }

      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft' || event.key === 'Tab') {
        const direction = getComputedStyle(bar).direction;
        const rtl = direction === 'rtl';
        const forward = event.key === 'ArrowRight'
          ? !rtl
          : event.key === 'ArrowLeft'
            ? rtl
            : !event.shiftKey;

        const focusable = getFocusable(bar);
        if (focusable.length === 0) return;

        const currentIndex = focusable.indexOf(document.activeElement as HTMLElement);
        let nextIndex: number;
        if (currentIndex < 0) {
          nextIndex = forward ? 0 : focusable.length - 1;
        } else {
          nextIndex = forward
            ? (currentIndex + 1) % focusable.length
            : (currentIndex - 1 + focusable.length) % focusable.length;
        }

        event.preventDefault();
        focusable[nextIndex]?.focus();
      }
    },
    [onClearSelection],
  );

  // ── Keyboard: more-menu navigation ──
  const handleMoreMenuKeyDown = useCallback(
    (event: KeyboardEvent, itemCount: number) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        event.stopPropagation();
        setMoreOpen(false);
        moreBtnRef.current?.focus();
        return;
      }
      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setMoreMenuFocusIndex((prev) => (prev + 1) % itemCount);
        return;
      }
      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setMoreMenuFocusIndex((prev) => (prev - 1 + itemCount) % itemCount);
        return;
      }
      if (event.key === 'Home') {
        event.preventDefault();
        setMoreMenuFocusIndex(0);
        return;
      }
      if (event.key === 'End') {
        event.preventDefault();
        setMoreMenuFocusIndex(itemCount - 1);
        return;
      }
    },
    [],
  );

  // Focus the nth item in more menu when focusIndex changes.
  useEffect(() => {
    if (!moreOpen || !moreMenuRef.current) return;
    const items = moreMenuRef.current.querySelectorAll<HTMLElement>(
      'button:not([disabled])',
    );
    items[moreMenuFocusIndex]?.focus();
  }, [moreOpen, moreMenuFocusIndex]);

  // ── Build visible actions ──
  const hasDelete = !!onDeleteSelected;
  const hasRestore = !!onRestoreSelected;
  const hasExport = !!onExportSelected;
  const hasExtra = !!(extraActions && extraActions.length > 0);
  const hasAnyAction = hasDelete || hasRestore || hasExport || hasExtra;

  return (
    <div
      ref={barRef}
      className="selection-action-bar"
      role="toolbar"
      aria-label={toolbarLabel}
      aria-hidden={!visible}
      data-responsive-band={resolvedBand}
      onKeyDown={handleToolbarKeyDown}
      // Allow focusing the toolbar itself when all children are disabled.
      tabIndex={visible ? -1 : undefined}
      style={!visible ? { display: 'none' } : undefined}
    >
      {/* ── Count badge ── */}
      <div className="selection-action-bar__count" aria-live="polite" aria-atomic="true">
        <Check className="selection-action-bar__count-icon" aria-hidden="true" />
        <span className="selection-action-bar__count-text">{actionLabel}</span>
      </div>

      {/* ── Separator ── */}
      {hasAnyAction && <div className="selection-action-bar__separator" aria-hidden="true" />}

      {/* ── Action buttons ── */}
      {hasAnyAction && (
        <div className="selection-action-bar__actions" role="group" aria-label="批量操作">
          {/* Restore */}
          {hasRestore && (
            <button
              type="button"
              className={`selection-action-bar__btn selection-action-bar__btn--restore ${
                isLoading('restore') ? 'selection-action-bar__btn--loading' : ''
              }`}
              onClick={() => runAction('restore', onRestoreSelected)}
              disabled={isLoading('restore')}
              aria-label={`恢复已选择的${itemLabel}`}
              aria-busy={isLoading('restore')}
            >
              <RotateCcw size={15} aria-hidden="true" />
              <span>恢复</span>
              {isLoading('restore') && (
                <span className="selection-action-bar__spinner" aria-hidden="true" />
              )}
            </button>
          )}

          {/* Delete */}
          {hasDelete && (
            <button
              type="button"
              className={`selection-action-bar__btn selection-action-bar__btn--danger ${
                isLoading('delete') ? 'selection-action-bar__btn--loading' : ''
              }`}
              onClick={() => runAction('delete', onDeleteSelected)}
              disabled={isLoading('delete')}
              aria-label={`删除已选择的${itemLabel}`}
              aria-busy={isLoading('delete')}
            >
              <Trash2 size={15} aria-hidden="true" />
              <span>删除</span>
              {isLoading('delete') && (
                <span className="selection-action-bar__spinner" aria-hidden="true" />
              )}
            </button>
          )}

          {/* Export */}
          {hasExport && (
            <button
              type="button"
              className={`selection-action-bar__btn ${
                isLoading('export') ? 'selection-action-bar__btn--loading' : ''
              }`}
              onClick={() => runAction('export', onExportSelected)}
              disabled={isLoading('export')}
              aria-label={`导出已选择的${itemLabel}`}
              aria-busy={isLoading('export')}
            >
              <Download size={15} aria-hidden="true" />
              <span>导出</span>
              {isLoading('export') && (
                <span className="selection-action-bar__spinner" aria-hidden="true" />
              )}
            </button>
          )}

          {/* More-actions dropdown */}
          {hasExtra && extraActions && (
            <div className="selection-action-bar__more">
              <button
                ref={moreBtnRef}
                type="button"
                className="selection-action-bar__btn"
                onClick={toggleMoreMenu}
                aria-label="更多操作"
                aria-expanded={moreOpen}
                aria-haspopup="true"
                disabled={loading}
              >
                <MoreHorizontal size={15} aria-hidden="true" />
                <span>{resolvedBand === 'wide' ? '更多' : ''}</span>
                <ChevronUp
                  size={12}
                  aria-hidden="true"
                  style={{
                    transform: moreOpen ? 'rotate(0deg)' : 'rotate(180deg)',
                    transition: 'transform 0.15s',
                  }}
                />
              </button>

              {moreOpen && (
                <div
                  ref={moreMenuRef}
                  className="selection-action-bar__more-menu"
                  role="menu"
                  aria-label="更多批量操作"
                  onKeyDown={(event) => handleMoreMenuKeyDown(event, extraActions.length)}
                >
                  {extraActions.map((action) => (
                    <button
                      key={action.id}
                      type="button"
                      role="menuitem"
                      className={`selection-action-bar__more-item ${
                        action.danger ? 'selection-action-bar__more-item--danger' : ''
                      }`}
                      onClick={() => {
                        setMoreOpen(false);
                        runAction(`extra-${action.id}`, action.onClick);
                      }}
                      disabled={action.disabled || loading || action.loading}
                      aria-busy={action.loading}
                    >
                      {action.icon}
                      <span>{action.label}</span>
                      {action.loading && (
                        <span className="selection-action-bar__spinner" aria-hidden="true" />
                      )}
                    </button>
                  ))}

                  {extraActions.length === 0 && (
                    <div
                      className="selection-action-bar__more-item"
                      role="menuitem"
                      aria-disabled="true"
                      style={{ color: 'var(--text-muted, #718096)', cursor: 'default' }}
                    >
                      无额外操作
                    </div>
                  )}
                </div>
              )}
            </div>
          )}
        </div>
      )}

      {/* ── Error state ── */}
      {displayedError && (
        <div className="selection-action-bar__error" role="alert">
          <span className="selection-action-bar__error-text">{displayedError}</span>
          {(actionError || onRetry) && (
            <button
              type="button"
              className="selection-action-bar__retry-btn"
              onClick={handleRetry}
              aria-label="重试"
            >
              <RefreshCw size={12} aria-hidden="true" />
              <span>重试</span>
            </button>
          )}
        </div>
      )}

      {/* ── Clear selection ── */}
      {onClearSelection && (
        <button
          type="button"
          className="selection-action-bar__clear"
          onClick={onClearSelection}
          disabled={loading}
          aria-label="清空选择"
        >
          <X size={14} aria-hidden="true" />
          <span>{resolvedBand === 'wide' ? '清空选择' : '清空'}</span>
        </button>
      )}
    </div>
  );
}

export { Check, Trash2, RotateCcw, Download, X, ChevronUp, RefreshCw, MoreHorizontal };
