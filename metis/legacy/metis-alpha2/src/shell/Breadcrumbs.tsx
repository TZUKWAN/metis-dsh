/**
 * Breadcrumbs — hierarchical path navigation with overflow collapse.
 *
 * Displays a trail of clickable segments showing the user's current
 * location within the project/workspace hierarchy.  When items exceed
 * `maxItems` the middle segments are collapsed into an ellipsis button
 * that expands on click / Enter / Space.
 *
 * States: loading (skeleton), empty (placeholder), error (message + retry),
 * normal (renders the trail).  All interactive elements are keyboard-
 * accessible (ArrowLeft / ArrowRight / Home / End / Enter / Space / Escape
 * on the collapsed popover).
 */

import {
  Fragment,
  useState,
  useCallback,
  useRef,
  useEffect,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import { ChevronRight, MoreHorizontal, AlertTriangle } from 'lucide-react';
import './Breadcrumbs.css';

/* eslint-disable react-hooks/preserve-manual-memoization */

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export interface BreadcrumbItem {
  /** Unique identifier for React keys and dedup. */
  id: string;
  /** Visible text. */
  label: string;
  /** Optional link (renders as <a> when `onClick` is also absent). */
  href?: string;
  /** Optional leading icon. */
  icon?: ReactNode;
  /** Callback-based navigation (props-driven, no internal routing). */
  onClick?: (item: BreadcrumbItem) => void;
  /** When true the item uses a button but is not interactive (current page). */
  current?: boolean;
  /** Accessible label override for the crumb link/button. */
  ariaLabel?: string;
}

export interface BreadcrumbsProps {
  /** Ordered breadcrumb trail (root → leaf). */
  items: BreadcrumbItem[];

  /** Visual separator between crumbs. Defaults to the project's chevron. */
  separator?: ReactNode;

  /** Maximum visible items before collapsing the middle. Default 6. */
  maxItems?: number;

  /** Label for the collapsed-items trigger. Default "…". */
  collapsedLabel?: string;

  /** Fired when any crumb (including collapsed) is activated via click/keyboard. */
  onNavigate?: (item: BreadcrumbItem, index: number) => void;

  /** Size variant. */
  size?: 'sm' | 'md' | 'lg';

  /* ── State slots ──────────────────────────────────────────── */

  loading?: boolean;
  empty?: boolean;
  emptyMessage?: string;
  error?: string;
  /** Rendered as a button next to the error message. */
  onRetry?: () => void;

  /* ── Accessibility ────────────────────────────────────────── */

  ariaLabel?: string;
  className?: string;
}

/* ------------------------------------------------------------------ */
/*  Helpers                                                            */
/* ------------------------------------------------------------------ */

function buildVisible(items: BreadcrumbItem[], maxItems: number) {
  if (items.length <= maxItems) {
    return { head: items, collapsed: [] as BreadcrumbItem[], tail: [] as BreadcrumbItem[] };
  }

  // Head: 1 item; Tail: maxItems - 2 items (so total visible = maxItems - 1 + ellipsis)
  const headCount = 1;
  const tailCount = Math.max(1, maxItems - 2);
  const head = items.slice(0, headCount);
  const tail = items.slice(-tailCount);
  const collapsed = items.slice(headCount, -tailCount || undefined);
  return { head, collapsed, tail };
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

export default function Breadcrumbs({
  items,
  separator,
  maxItems = 6,
  collapsedLabel = '…',
  onNavigate,
  size = 'md',
  loading = false,
  empty = false,
  emptyMessage = '暂无路径信息',
  error,
  onRetry,
  ariaLabel = '面包屑导航',
  className = '',
}: BreadcrumbsProps) {
  const navRef = useRef<HTMLElement>(null);
  const collapsedBtnRef = useRef<HTMLButtonElement>(null);
  const popoverRef = useRef<HTMLDivElement>(null);
  const [collapsedOpen, setCollapsedOpen] = useState(false);
  const [focusedCollapsedIndex, setFocusedCollapsedIndex] = useState(-1);

  /* Collapse logic */
  const { head, collapsed, tail } = buildVisible(items, maxItems);
  const hasCollapsed = collapsed.length > 0;
  const visibleItems = [...head, ...tail];

  /* Close popover on outside click / Escape */
  useEffect(() => {
    if (!collapsedOpen) return;
    const handler = (e: MouseEvent) => {
      if (
        popoverRef.current &&
        !popoverRef.current.contains(e.target as Node) &&
        collapsedBtnRef.current &&
        !collapsedBtnRef.current.contains(e.target as Node)
      ) {
        setCollapsedOpen(false);
        setFocusedCollapsedIndex(-1);
      }
    };
    const keyHandler = (e: globalThis.KeyboardEvent) => {
      if (e.key === 'Escape') {
        setCollapsedOpen(false);
        setFocusedCollapsedIndex(-1);
        collapsedBtnRef.current?.focus();
      }
    };
    document.addEventListener('mousedown', handler);
    document.addEventListener('keydown', keyHandler);
    return () => {
      document.removeEventListener('mousedown', handler);
      document.removeEventListener('keydown', keyHandler);
    };
  }, [collapsedOpen]);

  /* ── Keyboard navigation for visible crumbs ── */
  const handleCrumbKeyDown = useCallback(
    (
      e: KeyboardEvent<HTMLElement>,
      item: BreadcrumbItem,
      index: number,
      allItems: BreadcrumbItem[],
    ) => {
      const rtl = navRef.current
        ? getComputedStyle(navRef.current).direction === 'rtl'
        : false;

      if (e.key === 'ArrowRight' || e.key === 'ArrowLeft') {
        e.preventDefault();
        const delta = (e.key === 'ArrowRight' ? 1 : -1) * (rtl ? -1 : 1);
        const next = index + delta;
        if (next >= 0 && next < allItems.length) {
          const selector = `[data-breadcrumb-index="${next}"]`;
          (navRef.current?.querySelector(selector) as HTMLElement)?.focus();
        }
        return;
      }
      if (e.key === 'Home') {
        e.preventDefault();
        const first = navRef.current?.querySelector('[data-breadcrumb-index="0"]') as HTMLElement;
        first?.focus();
        return;
      }
      if (e.key === 'End') {
        e.preventDefault();
        const lastIdx = allItems.length - 1;
        const last = navRef.current?.querySelector(
          `[data-breadcrumb-index="${lastIdx}"]`,
        ) as HTMLElement;
        last?.focus();
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onNavigate?.(item, index);
        item.onClick?.(item);
        return;
      }
    },
    [onNavigate],
  );

  /* ── Collapsed button keyboard ── */
  const handleCollapsedBtnKeyDown = useCallback(
    (e: KeyboardEvent<HTMLButtonElement>) => {
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        setCollapsedOpen((prev) => !prev);
        if (!collapsedOpen) {
          requestAnimationFrame(() => {
            setFocusedCollapsedIndex(0);
            const first = popoverRef.current?.querySelector(
              '[data-collapsed-index="0"]',
            ) as HTMLElement;
            first?.focus();
          });
        }
        return;
      }
      if (e.key === 'ArrowDown' && !collapsedOpen) {
        e.preventDefault();
        setCollapsedOpen(true);
        requestAnimationFrame(() => {
          setFocusedCollapsedIndex(0);
          const first = popoverRef.current?.querySelector(
            '[data-collapsed-index="0"]',
          ) as HTMLElement;
          first?.focus();
        });
      }
    },
    [collapsedOpen],
  );

  /* ── Popover item keyboard ── */
  const handleCollapsedItemKeyDown = useCallback(
    (e: KeyboardEvent<HTMLElement>, item: BreadcrumbItem, idx: number) => {
      if (e.key === 'ArrowDown') {
        e.preventDefault();
        const next = idx + 1;
        if (next < collapsed.length) {
          setFocusedCollapsedIndex(next);
          (popoverRef.current?.querySelector(
            `[data-collapsed-index="${next}"]`,
          ) as HTMLElement)?.focus();
        }
        return;
      }
      if (e.key === 'ArrowUp') {
        e.preventDefault();
        const prev = idx - 1;
        if (prev >= 0) {
          setFocusedCollapsedIndex(prev);
          (popoverRef.current?.querySelector(
            `[data-collapsed-index="${prev}"]`,
          ) as HTMLElement)?.focus();
        } else {
          setCollapsedOpen(false);
          setFocusedCollapsedIndex(-1);
          collapsedBtnRef.current?.focus();
        }
        return;
      }
      if (e.key === 'Enter' || e.key === ' ') {
        e.preventDefault();
        onNavigate?.(item, head.length + idx);
        item.onClick?.(item);
        setCollapsedOpen(false);
        setFocusedCollapsedIndex(-1);
        collapsedBtnRef.current?.focus();
        return;
      }
      if (e.key === 'Escape') {
        setCollapsedOpen(false);
        setFocusedCollapsedIndex(-1);
        collapsedBtnRef.current?.focus();
      }
    },
    [collapsed, head.length, onNavigate],
  );

  /* ── Render helpers ── */
  const renderSeparator = () => (
    <li className="breadcrumbs__separator" aria-hidden="true">
      {separator ?? (
        <>
          <ChevronRight className="breadcrumbs__separator-icon" size={14} aria-hidden="true" />
        </>
      )}
    </li>
  );

  const renderCrumb = (item: BreadcrumbItem, index: number, isLast: boolean) => {
    const Tag = item.href && !item.onClick ? 'a' : 'button';
    const interactive = !isLast || item.onClick !== undefined || item.href !== undefined;
    const isCurrent = item.current ?? isLast;

    return (
      <li
        key={item.id}
        className={`breadcrumbs__item ${isCurrent ? 'breadcrumbs__item--current' : ''}`}
      >
        <Tag
          className={`breadcrumbs__crumb ${isCurrent ? 'breadcrumbs__crumb--current' : ''}`}
          {...(Tag === 'a'
            ? { href: item.href! }
            : { type: 'button', disabled: !interactive ? true : undefined })}
          onClick={
            interactive
              ? (e: React.MouseEvent) => {
                  // Let anchor tags do their native thing unless onClick overrides
                  if (item.onClick) {
                    e.preventDefault();
                    item.onClick(item);
                  }
                  onNavigate?.(item, index);
                }
              : undefined
          }
          data-breadcrumb-index={index}
          aria-current={isCurrent ? 'page' : undefined}
          aria-label={item.ariaLabel ?? item.label}
          tabIndex={isCurrent && !interactive ? -1 : 0}
          onKeyDown={(e) => handleCrumbKeyDown(e, item, index, visibleItems)}
        >
          {item.icon && <span className="breadcrumbs__crumb-icon">{item.icon}</span>}
          <span className="breadcrumbs__crumb-label">{item.label}</span>
        </Tag>
      </li>
    );
  };

  /* ── Loading skeleton ── */
  if (loading) {
    return (
      <nav
        className={`breadcrumbs breadcrumbs--${size} breadcrumbs--loading ${className}`.trim()}
        aria-label={ariaLabel}
        aria-busy="true"
      >
        <ol className="breadcrumbs__list">
          {Array.from({ length: 3 }).flatMap((_, i, arr) => {
            const elements: ReactNode[] = [
              <li key={`skel-${i}`} className="breadcrumbs__item">
                <span className="breadcrumbs__skeleton" aria-hidden="true" />
              </li>,
            ];
            if (i < arr.length - 1) {
              elements.push(
                <li key={`skel-sep-${i}`} className="breadcrumbs__separator" aria-hidden="true">
                  <ChevronRight className="breadcrumbs__separator-icon" size={14} aria-hidden="true" />
                </li>,
              );
            }
            return elements;
          })}
        </ol>
      </nav>
    );
  }

  /* ── Error ── */
  if (error) {
    return (
      <nav
        className={`breadcrumbs breadcrumbs--${size} breadcrumbs--error ${className}`.trim()}
        aria-label={ariaLabel}
        role="alert"
      >
        <div className="breadcrumbs__error">
          <AlertTriangle className="breadcrumbs__error-icon" size={14} aria-hidden="true" />
          <span className="breadcrumbs__error-text">{error}</span>
          {onRetry && (
            <button
              type="button"
              className="breadcrumbs__retry-btn"
              onClick={onRetry}
            >
              重试
            </button>
          )}
        </div>
      </nav>
    );
  }

  /* ── Empty ── */
  if (empty || items.length === 0) {
    return (
      <nav
        className={`breadcrumbs breadcrumbs--${size} breadcrumbs--empty ${className}`.trim()}
        aria-label={ariaLabel}
      >
        <div className="breadcrumbs__empty">
          <span>{emptyMessage}</span>
        </div>
      </nav>
    );
  }

  /* ── Normal render ── */
  return (
    <nav
      ref={navRef}
      className={`breadcrumbs breadcrumbs--${size} ${className}`.trim()}
      aria-label={ariaLabel}
    >
      <ol className="breadcrumbs__list">
        {/* Head items */}
        {head.map((item, i) => (
          <Fragment key={item.id}>
            {renderCrumb(item, i, false)}
            {(i < head.length - 1 || hasCollapsed || tail.length > 0) && renderSeparator()}
          </Fragment>
        ))}

        {/* Collapsed indicator */}
        {hasCollapsed && (
          <li className="breadcrumbs__item breadcrumbs__item--collapsed">
            <button
              ref={collapsedBtnRef}
              type="button"
              className="breadcrumbs__collapsed-btn"
              aria-label={`显示 ${collapsed.length} 个隐藏路径`}
              aria-expanded={collapsedOpen}
              aria-haspopup="listbox"
              onClick={() => setCollapsedOpen((prev) => !prev)}
              onKeyDown={handleCollapsedBtnKeyDown}
              title={`${collapsed.length} 个中间层级`}
            >
              <MoreHorizontal size={14} aria-hidden="true" />
              <span className="breadcrumbs__collapsed-label">{collapsedLabel}</span>
            </button>

            {collapsedOpen && (
              <div
                ref={popoverRef}
                className="breadcrumbs__popover"
                role="listbox"
                aria-label="隐藏路径"
              >
                <ol className="breadcrumbs__popover-list">
                  {collapsed.map((item, idx) => (
                    <li
                      key={item.id}
                      role="option"
                      aria-selected={focusedCollapsedIndex === idx}
                    >
                      <button
                        type="button"
                        className={`breadcrumbs__popover-item ${
                          focusedCollapsedIndex === idx ? 'breadcrumbs__popover-item--focused' : ''
                        }`}
                        data-collapsed-index={idx}
                        tabIndex={focusedCollapsedIndex === idx ? 0 : -1}
                        onClick={() => {
                          item.onClick?.(item);
                          onNavigate?.(item, head.length + idx);
                          setCollapsedOpen(false);
                          setFocusedCollapsedIndex(-1);
                          collapsedBtnRef.current?.focus();
                        }}
                        onKeyDown={(e) => handleCollapsedItemKeyDown(e, item, idx)}
                      >
                        {item.icon && (
                          <span className="breadcrumbs__popover-item-icon">{item.icon}</span>
                        )}
                        <span className="breadcrumbs__popover-item-label">{item.label}</span>
                      </button>
                    </li>
                  ))}
                </ol>
              </div>
            )}
          </li>
        )}

        {/* Separator after collapsed (if tail exists) */}
        {hasCollapsed && tail.length > 0 && renderSeparator()}

        {/* Tail items */}
        {tail.map((item, i) => {
          const globalIndex = head.length + collapsed.length + i;
          const isLast = i === tail.length - 1;
          return (
            <Fragment key={item.id}>
              {renderCrumb(item, globalIndex, isLast)}
              {!isLast && renderSeparator()}
            </Fragment>
          );
        })}
      </ol>
    </nav>
  );
}
