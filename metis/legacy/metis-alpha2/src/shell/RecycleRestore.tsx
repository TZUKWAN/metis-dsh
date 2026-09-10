/**
 * RecycleRestore — standalone recycle-bin / restore panel for deleted research entities.
 *
 * Features:
 *   - List of deleted items with timeline grouping by date.
 *   - Real-time search filter (title, type, original location, metadata).
 *   - Multi-selection with "select all" and per-item checkboxes.
 *   - Restore and permanently-delete batch actions exposed as props callbacks.
 *   - Confirmation dialog for destructive permanent-delete (and optional restore confirm).
 *   - Loading skeleton, empty, error with retry, and recovery banners.
 *   - Full keyboard support, RTL logical properties, forced-colors, reduced-motion.
 *   - data-responsive-band for narrow-screen adaptation.
 *
 * All backend-dependent work is delegated through props; this component never invents results.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
} from 'react';
import {
  AlertTriangle,
  Calendar,
  CheckSquare,
  Clock,
  LoaderCircle,
  RefreshCw,
  RotateCcw,
  Search,
  Square,
  Trash2,
  X,
} from 'lucide-react';
import './RecycleRestore.css';

/* ------------------------------------------------------------------ */
/*  Types                                                              */
/* ------------------------------------------------------------------ */

export type RecycleEntityType =
  | 'note'
  | 'source'
  | 'project'
  | 'analysis'
  | 'write'
  | string;

export interface RecycleItem {
  /** Stable entity identifier. */
  id: string;
  /** Display name of the deleted entity. */
  title: string;
  /** Logical entity type (used for icon/label mapping). */
  entityType: RecycleEntityType;
  /** Deletion timestamp (ms since epoch). */
  deletedAt: number;
  /** Optional user/account that performed the deletion. */
  deletedBy?: string;
  /** Optional human-readable original location/path. */
  originalLocation?: string;
  /** Optional key/value metadata shown in the item row. */
  metadata?: Record<string, string>;
  /** Hide permanent deletion for this item while preserving selection and restore. Defaults to true. */
  allowPermanentDelete?: boolean;
}

export interface RecycleRestoreLabels {
  /** Panel title. */
  title: string;
  /** Panel subtitle shown under the title. */
  subtitle: string;
  /** Search input placeholder. */
  searchPlaceholder: string;
  /** Loading message. */
  loading: string;
  /** Empty-state heading. */
  empty: string;
  /** Empty-state hint shown when a search has no matches. */
  emptySearchHint: string;
  /** Empty-state hint shown when the bin is truly empty. */
  emptyBinHint: string;
  /** Error banner prefix. */
  errorTitle: string;
  /** Retry button label. */
  retry: string;
  /** Refresh button label. */
  refresh: string;
  /** Close error button label. */
  closeError: string;
  /** Select-all checkbox accessible label. */
  selectAll: string;
  /** Selection count label. Use {count} placeholder. */
  selected: string;
  /** Restore button label. */
  restore: string;
  /** Permanently-delete button label. */
  deleteForever: string;
  /** Cancel button label. */
  cancel: string;
  /** Confirm-delete dialog title. */
  confirmDeleteTitle: string;
  /** Confirm-delete message. Use {count} and {label} placeholders. */
  confirmDeleteMessage: string;
  /** Confirm-delete action button label. */
  confirmDeleteButton: string;
  /** Confirm-restore dialog title. */
  confirmRestoreTitle: string;
  /** Confirm-restore message. Use {count} and {label} placeholders. */
  confirmRestoreMessage: string;
  /** Confirm-restore action button label. */
  confirmRestoreButton: string;
  /** Recovery banner after a successful restore. Use {count} placeholder. */
  restoredMessage: string;
  /** Recovery banner after a successful permanent delete. Use {count} placeholder. */
  deletedMessage: string;
  /** Dismiss recovery banner label. */
  dismiss: string;
  /** Today group label. */
  today: string;
  /** Yesterday group label. */
  yesterday: string;
  /** Older group label. */
  older: string;
  /** Map of entity-type keys to human-readable labels. */
  entityTypes: Record<string, string>;
  /** Generic item label used in count messages. */
  itemLabel: string;
}

export interface RecycleRestoreProps {
  /** Deleted items currently in the recycle bin. */
  items: RecycleItem[];
  /** When true, the list shows a loading skeleton. */
  loading?: boolean;
  /** Error message to display. Cleared via `onClearError` or `onRefresh`. */
  error?: string | null;
  /** Optional external recovery message (e.g. from the parent store after undo). */
  recoveryMessage?: string | null;
  /** Dismiss the external recovery message. */
  onDismissRecovery?: () => void;
  /** Clear the current error without retrying. */
  onClearError?: () => void;
  /** Refresh / retry loading the bin contents. */
  onRefresh?: () => void | Promise<void>;
  /** Restore the selected items. */
  onRestore?: (ids: string[]) => void | Promise<void>;
  /** Permanently delete the selected items. */
  onDeleteForever?: (ids: string[]) => void | Promise<void>;
  /** When true, restoring also shows a confirmation dialog. */
  confirmRestore?: boolean;
  /** Generic label for one item (used in messages). */
  itemLabel?: string;
  /** Optional copy overrides. */
  labels?: Partial<RecycleRestoreLabels>;
  /** Additional class for the root element. */
  className?: string;
  /** Format a relative timestamp (e.g. "3 小时前"). */
  formatRelativeTime?: (timestamp: number) => string;
  /** Format a date for timeline grouping. */
  formatDate?: (timestamp: number) => string;
  /** Format a date group key/label. Return a stable key for the same calendar day. */
  formatDateGroup?: (timestamp: number) => string;
}

/* ------------------------------------------------------------------ */
/*  Defaults                                                           */
/* ------------------------------------------------------------------ */

const DEFAULT_LABELS: RecycleRestoreLabels = {
  title: '回收站',
  subtitle: '已删除的项目与实体',
  searchPlaceholder: '搜索已删除项目…',
  loading: '加载回收站…',
  empty: '回收站是空的',
  emptySearchHint: '没有匹配当前搜索的已删除项目。',
  emptyBinHint: '删除的项目会在这里显示，并可在需要时恢复。',
  errorTitle: '加载失败',
  retry: '重试',
  refresh: '刷新',
  closeError: '关闭提示',
  selectAll: '全选',
  selected: '已选择 {count} 项',
  restore: '恢复',
  deleteForever: '永久删除',
  cancel: '取消',
  confirmDeleteTitle: '确认永久删除？',
  confirmDeleteMessage: '即将永久删除 {count} 个{label}。此操作不可撤销。',
  confirmDeleteButton: '确认删除',
  confirmRestoreTitle: '确认恢复？',
  confirmRestoreMessage: '即将恢复 {count} 个{label}。',
  confirmRestoreButton: '确认恢复',
  restoredMessage: '已成功恢复 {count} 个项目。',
  deletedMessage: '已永久删除 {count} 个项目。',
  dismiss: '知道了',
  today: '今天',
  yesterday: '昨天',
  older: '更早',
  entityTypes: {
    note: '笔记',
    source: '文献',
    project: '项目',
    analysis: '分析',
    write: '写作',
  },
  itemLabel: '项目',
};

function resolveLabels(provided: Partial<RecycleRestoreLabels> | undefined): RecycleRestoreLabels {
  return {
    ...DEFAULT_LABELS,
    ...provided,
    entityTypes: { ...DEFAULT_LABELS.entityTypes, ...provided?.entityTypes },
  };
}

function formatMessage(template: string, values: Record<string, string | number>): string {
  return template.replace(/\{(\w+)\}/g, (_, key) => String(values[key] ?? ''));
}

function normalize(text: string): string {
  return text.trim().toLowerCase();
}

function isSameDay(a: Date, b: Date): boolean {
  return (
    a.getFullYear() === b.getFullYear() &&
    a.getMonth() === b.getMonth() &&
    a.getDate() === b.getDate()
  );
}

function defaultFormatRelativeTime(timestamp: number): string {
  const diff = Date.now() - timestamp;
  const minutes = Math.floor(diff / 60000);
  if (minutes < 1) return '刚刚';
  if (minutes < 60) return `${minutes} 分钟前`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours} 小时前`;
  const days = Math.floor(hours / 24);
  if (days < 30) return `${days} 天前`;
  return defaultFormatDate(timestamp);
}

function defaultFormatDate(timestamp: number): string {
  return new Date(timestamp).toLocaleDateString('zh-CN', {
    month: 'short',
    day: 'numeric',
  });
}

function defaultFormatDateGroup(timestamp: number): string {
  return new Date(timestamp).toDateString();
}

/* ------------------------------------------------------------------ */
/*  Filtering & grouping                                               */
/* ------------------------------------------------------------------ */

function filterItems(items: RecycleItem[], query: string, labels: RecycleRestoreLabels): RecycleItem[] {
  const needle = normalize(query);
  if (!needle) return items;

  return items.filter((item) => {
    const typeLabel = labels.entityTypes[item.entityType] ?? item.entityType;
    const parts = [
      item.title,
      typeLabel,
      item.originalLocation ?? '',
      item.deletedBy ?? '',
      ...Object.values(item.metadata ?? {}),
    ];
    return normalize(parts.join(' ')).includes(needle);
  });
}

interface RecycleGroup {
  key: string;
  label: string;
  items: RecycleItem[];
}

function groupItems(
  items: RecycleItem[],
  labels: RecycleRestoreLabels,
  formatGroup: (timestamp: number) => string,
): RecycleGroup[] {
  const sorted = [...items].sort((a, b) => b.deletedAt - a.deletedAt);
  const map = new Map<string, RecycleItem[]>();
  const now = new Date();
  const yesterday = new Date(now);
  yesterday.setDate(yesterday.getDate() - 1);

  for (const item of sorted) {
    const date = new Date(item.deletedAt);
    let label: string;
    if (isSameDay(date, now)) {
      label = labels.today;
    } else if (isSameDay(date, yesterday)) {
      label = labels.yesterday;
    } else {
      label = formatGroup(item.deletedAt);
    }

    const key = isSameDay(date, now)
      ? 'today'
      : isSameDay(date, yesterday)
        ? 'yesterday'
        : formatGroup(item.deletedAt);

    const group = map.get(key);
    if (group) {
      group.push(item);
    } else {
      map.set(key, [item]);
    }
    // Keep label association by key in a separate small map to avoid recomputing.
    if (!map.has(`__label__${key}`)) {
      map.set(`__label__${key}`, label as unknown as RecycleItem[]);
    }
  }

  const result: RecycleGroup[] = [];
  for (const [key, groupItemsList] of map.entries()) {
    if (key.startsWith('__label__')) continue;
    const labelEntry = map.get(`__label__${key}`);
    const label = (labelEntry as unknown as string) ?? key;
    result.push({ key, label, items: groupItemsList });
  }

  // Preserve chronological order: today, yesterday, then older descending.
  const order = (k: string) => (k === 'today' ? 0 : k === 'yesterday' ? 1 : 2);
  result.sort((a, b) => {
    const oa = order(a.key);
    const ob = order(b.key);
    if (oa !== ob) return oa - ob;
    // Both older: descending by first item timestamp.
    return (b.items[0]?.deletedAt ?? 0) - (a.items[0]?.deletedAt ?? 0);
  });

  return result;
}

/* ------------------------------------------------------------------ */
/*  Component                                                          */
/* ------------------------------------------------------------------ */

type ResponsiveBand = 'wide' | 'medium' | 'narrow';
type ConfirmAction = 'restore' | 'delete';

interface LastResult {
  kind: 'restored' | 'deleted';
  count: number;
}

export default function RecycleRestore({
  items,
  loading = false,
  error = null,
  recoveryMessage = null,
  onDismissRecovery,
  onClearError,
  onRefresh,
  onRestore,
  onDeleteForever,
  confirmRestore = false,
  itemLabel: itemLabelProp,
  labels: labelsProp,
  className = '',
  formatRelativeTime,
  formatDate,
  formatDateGroup,
}: RecycleRestoreProps) {
  const labels = resolveLabels(labelsProp);
  const itemLabel = itemLabelProp ?? labels.itemLabel;

  const formatRel = formatRelativeTime ?? defaultFormatRelativeTime;
  const formatDt = formatDate ?? defaultFormatDate;
  const formatGrp = formatDateGroup ?? defaultFormatDateGroup;

  const baseId = useId().replace(/:/g, '');
  const searchId = `${baseId}-recycle-search`;
  const listId = `${baseId}-recycle-list`;
  const errorId = `${baseId}-recycle-error`;

  const rootRef = useRef<HTMLDivElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const selectAllRef = useRef<HTMLInputElement>(null);
  const confirmCancelRef = useRef<HTMLButtonElement>(null);

  const [query, setQuery] = useState('');
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [responsiveBand, setResponsiveBand] = useState<ResponsiveBand>('wide');
  const [confirmAction, setConfirmAction] = useState<ConfirmAction | null>(null);
  const [opLoading, setOpLoading] = useState(false);
  const [lastResult, setLastResult] = useState<LastResult | null>(null);

  const sortedItems = useMemo(
    () => [...items].sort((a, b) => b.deletedAt - a.deletedAt),
    [items],
  );

  const filteredItems = useMemo(
    () => filterItems(sortedItems, query, labels),
    [sortedItems, query, labels],
  );

  const groups = useMemo(
    () => groupItems(filteredItems, labels, formatGrp),
    [filteredItems, labels, formatGrp],
  );

  const allItemIds = useMemo(() => new Set(items.map((item) => item.id)), [items]);

  const visibleIds = useMemo(
    () => new Set(filteredItems.map((item) => item.id)),
    [filteredItems],
  );

  // Keep only selections that still exist in the current item universe.
  const validSelectedIds = useMemo(() => {
    const next = new Set<string>();
    for (const id of selectedIds) {
      if (allItemIds.has(id)) next.add(id);
    }
    return next;
  }, [selectedIds, allItemIds]);

  const selectedVisibleCount = useMemo(() => {
    let count = 0;
    for (const id of validSelectedIds) {
      if (visibleIds.has(id)) count += 1;
    }
    return count;
  }, [validSelectedIds, visibleIds]);

  const hasVisibleItems = visibleIds.size > 0;
  const allVisibleSelected = hasVisibleItems && selectedVisibleCount === visibleIds.size;
  const someVisibleSelected = selectedVisibleCount > 0 && !allVisibleSelected;

  // Keep the "select all" checkbox indeterminate state in sync.
  useEffect(() => {
    if (selectAllRef.current) {
      selectAllRef.current.indeterminate = someVisibleSelected;
    }
  }, [someVisibleSelected]);

  // Responsive band detection.
  useEffect(() => {
    const root = rootRef.current;
    if (!root || typeof ResizeObserver === 'undefined') return;

    const updateBand = () => {
      const width = root.clientWidth;
      if (width <= 0) return;
      const nextBand: ResponsiveBand = width <= 320 ? 'narrow' : width <= 520 ? 'medium' : 'wide';
      setResponsiveBand((prev) => (prev === nextBand ? prev : nextBand));
    };

    updateBand();
    const observer = new ResizeObserver(updateBand);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Focus the search input on mount.
  useEffect(() => {
    if (!loading) {
      requestAnimationFrame(() => searchRef.current?.focus());
    }
  }, [loading]);

  // Focus the cancel button when a confirmation dialog opens.
  useEffect(() => {
    if (confirmAction) {
      requestAnimationFrame(() => confirmCancelRef.current?.focus());
    }
  }, [confirmAction]);

  // Close confirmation dialog on Escape.
  useEffect(() => {
    if (!confirmAction) return;
    const handler = (event: globalThis.KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        setConfirmAction(null);
      }
    };
    window.addEventListener('keydown', handler);
    return () => window.removeEventListener('keydown', handler);
  }, [confirmAction]);

  const toggleSelection = useCallback((id: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }, []);

  const toggleSelectAll = useCallback(() => {
    setSelectedIds((prev) => {
      const next = new Set(prev);
      if (allVisibleSelected) {
        for (const id of visibleIds) next.delete(id);
      } else {
        for (const id of visibleIds) next.add(id);
      }
      return next;
    });
  }, [allVisibleSelected, visibleIds]);

  const clearSelection = useCallback(() => setSelectedIds(new Set()), []);

  const validSelectedIdsArray = useMemo(() => Array.from(validSelectedIds), [validSelectedIds]);
  const permanentDeleteIds = useMemo(
    () => new Set(items
      .filter((item) => item.allowPermanentDelete !== false)
      .map((item) => item.id)),
    [items],
  );
  const permanentDeleteSelectedIdsArray = useMemo(
    () => validSelectedIdsArray.filter((id) => permanentDeleteIds.has(id)),
    [permanentDeleteIds, validSelectedIdsArray],
  );

  const runAction = useCallback(
    async (action: () => void | Promise<void>, kind: LastResult['kind'], ids?: string[]) => {
      const targetIds = ids ?? validSelectedIdsArray;
      setOpLoading(true);
      try {
        await action();
        setLastResult({ kind, count: targetIds.length });
        clearSelection();
      } catch {
        // Errors are expected to be surfaced by the parent via the `error` prop.
      } finally {
        setOpLoading(false);
        setConfirmAction(null);
      }
    },
    [validSelectedIdsArray, clearSelection],
  );

  const handleRestore = useCallback(() => {
    if (!onRestore || validSelectedIdsArray.length === 0) return;
    if (confirmRestore) {
      setConfirmAction('restore');
      return;
    }
    void runAction(() => onRestore(validSelectedIdsArray), 'restored');
  }, [confirmRestore, onRestore, runAction, validSelectedIdsArray]);

  const handleDeleteForever = useCallback(() => {
    if (!onDeleteForever || permanentDeleteSelectedIdsArray.length === 0) return;
    setConfirmAction('delete');
  }, [onDeleteForever, permanentDeleteSelectedIdsArray]);

  const executeConfirmedAction = useCallback(() => {
    if (confirmAction === 'restore' && onRestore) {
      void runAction(() => onRestore(validSelectedIdsArray), 'restored');
    } else if (confirmAction === 'delete' && onDeleteForever) {
      void runAction(
        () => onDeleteForever(permanentDeleteSelectedIdsArray),
        'deleted',
        permanentDeleteSelectedIdsArray,
      );
    }
  }, [confirmAction, onRestore, onDeleteForever, permanentDeleteSelectedIdsArray, runAction, validSelectedIdsArray]);

  const handleRefresh = useCallback(() => {
    onClearError?.();
    void onRefresh?.();
  }, [onClearError, onRefresh]);

  const dismissLastResult = useCallback(() => setLastResult(null), []);

  const recoveryBanner = recoveryMessage ??
    (lastResult ? formatMessage(
      lastResult.kind === 'restored' ? labels.restoredMessage : labels.deletedMessage,
      { count: lastResult.count },
    ) : null);

  const showRecovery = recoveryBanner != null && recoveryBanner !== '';

  const handleSearchKeyDown = useCallback((event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key === 'Escape') {
      event.preventDefault();
      setQuery('');
    }
  }, []);

  const renderItem = (item: RecycleItem) => {
    const selected = validSelectedIds.has(item.id);
    const typeLabel = labels.entityTypes[item.entityType] ?? item.entityType;
    const deletedBy = item.deletedBy ? `由 ${item.deletedBy} 删除` : '已删除';

    return (
      <li key={item.id} className="recycle-restore__item">
        <label
          className="recycle-restore__checkbox-label"
          htmlFor={`${baseId}-checkbox-${item.id}`}
        >
          <input
            id={`${baseId}-checkbox-${item.id}`}
            type="checkbox"
            className="recycle-restore__checkbox"
            checked={selected}
            onChange={() => toggleSelection(item.id)}
            aria-label={`选择 ${item.title}`}
          />
          <span className="recycle-restore__checkbox-icon" aria-hidden="true">
            {selected ? <CheckSquare size={15} /> : <Square size={15} />}
          </span>
        </label>

        <div className="recycle-restore__content">
          <div className="recycle-restore__row">
            <span className="recycle-restore__type">{typeLabel}</span>
            <span className="recycle-restore__time" title={formatDt(item.deletedAt)}>
              <Clock size={11} aria-hidden="true" />
              {formatRel(item.deletedAt)}
            </span>
          </div>
          <strong className="recycle-restore__title-text">{item.title}</strong>
          {(item.originalLocation || item.deletedBy) && (
            <small className="recycle-restore__meta">
              {item.originalLocation && <span>{item.originalLocation}</span>}
              {item.originalLocation && item.deletedBy && <span aria-hidden="true"> · </span>}
              <span>{deletedBy}</span>
            </small>
          )}
          {item.metadata && Object.keys(item.metadata).length > 0 && (
            <div className="recycle-restore__metadata">
              {Object.entries(item.metadata).map(([key, value]) => (
                <span key={key} className="recycle-restore__metadata-item">
                  <span className="recycle-restore__metadata-key">{key}:</span>
                  <span className="recycle-restore__metadata-value">{value}</span>
                </span>
              ))}
            </div>
          )}
        </div>

        <div className="recycle-restore__item-actions">
          {onRestore && (
            <button
              type="button"
              className="recycle-restore__icon-btn recycle-restore__icon-btn--restore"
              onClick={() => {
                const ids = [item.id];
                setSelectedIds(new Set(ids));
                if (confirmRestore) {
                  setConfirmAction('restore');
                } else {
                  void runAction(() => onRestore(ids), 'restored', ids);
                }
              }}
              disabled={opLoading}
              aria-label={`恢复 ${item.title}`}
              title="恢复"
            >
              <RotateCcw size={15} />
            </button>
          )}
          {onDeleteForever && item.allowPermanentDelete !== false && (
            <button
              type="button"
              className="recycle-restore__icon-btn recycle-restore__icon-btn--danger"
              onClick={() => {
                const ids = [item.id];
                setSelectedIds(new Set(ids));
                setConfirmAction('delete');
              }}
              disabled={opLoading}
              aria-label={`永久删除 ${item.title}`}
              title="永久删除"
            >
              <Trash2 size={15} />
            </button>
          )}
        </div>
      </li>
    );
  };

  const confirmCount = confirmAction === 'delete'
    ? permanentDeleteSelectedIdsArray.length
    : validSelectedIdsArray.length;
  const confirmTitle = confirmAction === 'delete' ? labels.confirmDeleteTitle : labels.confirmRestoreTitle;
  const confirmMessage = confirmAction
    ? formatMessage(
        confirmAction === 'delete' ? labels.confirmDeleteMessage : labels.confirmRestoreMessage,
        { count: confirmCount, label: itemLabel },
      )
    : '';
  const confirmButtonLabel = confirmAction === 'delete' ? labels.confirmDeleteButton : labels.confirmRestoreButton;

  return (
    <div
      ref={rootRef}
      className={`recycle-restore ${className}`.trim()}
      data-responsive-band={responsiveBand}
      aria-busy={loading || opLoading}
    >
      {/* Header */}
      <div className="recycle-restore__header">
        <div className="recycle-restore__heading">
          <div className="recycle-restore__heading-mark" aria-hidden="true">
            <Trash2 size={16} />
          </div>
          <div className="recycle-restore__heading-copy">
            <strong>{labels.title}</strong>
            <span>{labels.subtitle}</span>
          </div>
        </div>

        {onRefresh && (
          <button
            type="button"
            className="recycle-restore__icon-btn"
            onClick={handleRefresh}
            disabled={loading || opLoading}
            aria-label={labels.refresh}
            title={labels.refresh}
          >
            <RefreshCw size={15} className={loading ? 'recycle-restore__spin' : ''} />
          </button>
        )}
      </div>

      {/* Search */}
      <div className="recycle-restore__search">
        <Search size={14} aria-hidden="true" />
        <input
          ref={searchRef}
          id={searchId}
          type="search"
          value={query}
          onChange={(event) => setQuery(event.target.value)}
          onKeyDown={handleSearchKeyDown}
          placeholder={labels.searchPlaceholder}
          aria-label={labels.searchPlaceholder}
          disabled={loading}
        />
        {query && (
          <button
            type="button"
            className="recycle-restore__search-clear"
            onClick={() => {
              setQuery('');
              searchRef.current?.focus();
            }}
            aria-label="清除搜索"
          >
            <X size={12} aria-hidden="true" />
          </button>
        )}
      </div>

      {/* Recovery banner */}
      {showRecovery && (
        <div className="recycle-restore__recovery" role="status">
          <span className="recycle-restore__recovery-text">{recoveryBanner}</span>
          <button
            type="button"
            className="recycle-restore__recovery-dismiss"
            onClick={() => {
              onDismissRecovery?.();
              dismissLastResult();
            }}
          >
            {labels.dismiss}
          </button>
        </div>
      )}

      {/* Error banner */}
      {error && (
        <div id={errorId} className="recycle-restore__error" role="alert">
          <AlertTriangle size={14} aria-hidden="true" />
          <div className="recycle-restore__error-copy">
            <strong>{labels.errorTitle}</strong>
            <span>{error}</span>
          </div>
          <div className="recycle-restore__error-actions">
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
          </div>
        </div>
      )}

      {/* Select-all toolbar */}
      {hasVisibleItems && !loading && (
        <div className="recycle-restore__select-bar">
          <label className="recycle-restore__select-all" htmlFor={`${baseId}-select-all`}>
            <input
              ref={selectAllRef}
              id={`${baseId}-select-all`}
              type="checkbox"
              className="recycle-restore__checkbox"
              checked={allVisibleSelected}
              onChange={toggleSelectAll}
              aria-label={labels.selectAll}
            />
            <span className="recycle-restore__checkbox-icon" aria-hidden="true">
              {allVisibleSelected ? <CheckSquare size={15} /> : <Square size={15} />}
            </span>
            <span>{labels.selectAll}</span>
          </label>
          <span className="recycle-restore__count" aria-live="polite" aria-atomic="true">
            {formatMessage(labels.selected, { count: validSelectedIds.size })}
          </span>
        </div>
      )}

      {/* Main list */}
      <div className="recycle-restore__scroll" role="region" aria-label={labels.title}>
        {loading && (
          <div className="recycle-restore__loading" role="status">
            <LoaderCircle size={18} className="recycle-restore__spin" aria-hidden="true" />
            <span>{labels.loading}</span>
          </div>
        )}

        {!loading && groups.length === 0 && (
          <div className="recycle-restore__empty">
            <Trash2 size={28} aria-hidden="true" />
            <strong>{labels.empty}</strong>
            <p>{query ? labels.emptySearchHint : labels.emptyBinHint}</p>
          </div>
        )}

        {!loading && groups.length > 0 && (
          <ol id={listId} className="recycle-restore__list" role="list">
            {groups.map((group) => (
              <li key={group.key} className="recycle-restore__group">
                <div className="recycle-restore__group-label">
                  <Calendar size={11} aria-hidden="true" />
                  <span>{group.label}</span>
                </div>
                <ul className="recycle-restore__group-list">
                  {group.items.map((item) => renderItem(item))}
                </ul>
              </li>
            ))}
          </ol>
        )}
      </div>

      {/* Batch action bar */}
      {validSelectedIds.size > 0 && (
        <div className="recycle-restore__action-bar" role="toolbar" aria-label="已选项操作">
          <span className="recycle-restore__action-count">
            {formatMessage(labels.selected, { count: validSelectedIds.size })}
          </span>
          <div className="recycle-restore__action-buttons">
            {onRestore && (
              <button
                type="button"
                className="recycle-restore__btn recycle-restore__btn--restore"
                onClick={handleRestore}
                disabled={opLoading}
                aria-busy={opLoading}
              >
                <RotateCcw size={14} aria-hidden="true" />
                <span>{labels.restore}</span>
              </button>
            )}
            {onDeleteForever && permanentDeleteSelectedIdsArray.length > 0 && (
              <button
                type="button"
                className="recycle-restore__btn recycle-restore__btn--danger"
                onClick={handleDeleteForever}
                disabled={opLoading}
                aria-busy={opLoading}
              >
                <Trash2 size={14} aria-hidden="true" />
                <span>{labels.deleteForever}</span>
              </button>
            )}
          </div>
          <button
            type="button"
            className="recycle-restore__btn recycle-restore__btn--quiet"
            onClick={clearSelection}
            disabled={opLoading}
            aria-label="清空选择"
          >
            <X size={14} aria-hidden="true" />
            <span>{labels.cancel}</span>
          </button>
        </div>
      )}

      {/* Confirmation dialog */}
      {confirmAction && (
        <div className="recycle-restore__confirm-overlay">
          <div
            className="recycle-restore__confirm"
            role="alertdialog"
            aria-modal="true"
            aria-label={confirmTitle}
          >
            <div className="recycle-restore__confirm-icon" aria-hidden="true">
              <AlertTriangle size={24} />
            </div>
            <strong className="recycle-restore__confirm-title">{confirmTitle}</strong>
            <p className="recycle-restore__confirm-message">{confirmMessage}</p>
            <div className="recycle-restore__confirm-actions">
              <button
                ref={confirmCancelRef}
                type="button"
                className="recycle-restore__btn recycle-restore__btn--quiet"
                onClick={() => setConfirmAction(null)}
                disabled={opLoading}
              >
                {labels.cancel}
              </button>
              <button
                type="button"
                className={`recycle-restore__btn ${
                  confirmAction === 'delete'
                    ? 'recycle-restore__btn--danger'
                    : 'recycle-restore__btn--primary'
                }`}
                onClick={executeConfirmedAction}
                disabled={opLoading}
                aria-busy={opLoading}
              >
                {opLoading && (
                  <LoaderCircle size={14} className="recycle-restore__spin" aria-hidden="true" />
                )}
                <span>{confirmButtonLabel}</span>
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

