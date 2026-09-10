/**
 * CommandBar — command palette overlay (KIMI-201).
 *
 * A full-screen command palette activated by Cmd/Ctrl+K or controlled via isOpen.
 * Features fuzzy search, grouped commands, full keyboard navigation (↑↓ Enter ESC),
 * and comprehensive state handling (empty / no-results / loading / error / recovery).
 *
 * Supports 200 % zoom, RTL, forced-colors, and prefers-reduced-motion.
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
  Search,
  Command as CommandIcon,
  CornerDownLeft,
  ArrowUp,
  ArrowDown,
  LoaderCircle,
  AlertTriangle,
  RotateCcw,
  type LucideIcon,
} from 'lucide-react';
import './CommandBar.css';

// ─── Types ────────────────────────────────────────────────────────

export interface CommandItem {
  /** Stable unique identifier. */
  id: string;
  /** Display label. */
  label: string;
  /** Optional description shown below the label. */
  description?: string;
  /** Group identifier — items with the same group are rendered together. */
  group: string;
  /** Optional lucide-react icon. */
  icon?: LucideIcon;
  /** Called when the command is selected. */
  onExecute: () => void;
  /** Disabled commands are shown but not selectable. */
  disabled?: boolean;
  /** Extra keywords to boost fuzzy matching. */
  keywords?: string[];
  /** Display-only shortcut hint (e.g. "⌘N"). */
  shortcut?: string;
}

export interface CommandGroup {
  /** Group identifier, must match CommandItem.group values. */
  id: string;
  /** Display label for the group header. */
  label: string;
}

export interface CommandBarProps {
  /** Controlled open state. */
  isOpen: boolean;
  /** Called when the palette closes (Escape, backdrop click, or command executed). */
  onClose: () => void;
  /** Available commands. */
  commands: CommandItem[];
  /** Group display order. Commands in unlisted groups appear under a default header. */
  groups?: CommandGroup[];
  /** Search input placeholder. */
  placeholder?: string;
  /** Enable Cmd/Ctrl+K global shortcut listener. Defaults to true. */
  enableGlobalShortcut?: boolean;
  /** Show a loading spinner if commands are being fetched asynchronously. */
  loading?: boolean;
  /** Error message when commands could not be loaded. */
  error?: string;
  /** Retry callback for error recovery. */
  onRetry?: () => void;
  /** Data attribute value from the responsive shell. */
  responsiveBand?: 'wide' | 'medium' | 'narrow';
}

// ─── Helpers ──────────────────────────────────────────────────────

/** Normalise a string for fuzzy comparison. */
function normalise(value: string): string {
  return value.toLowerCase().trim();
}

/**
 * Score how well `query` matches `target`.
 * Higher score = better match. Returns 0 for no match.
 */
function fuzzyScore(query: string, target: string): number {
  const q = normalise(query);
  const t = normalise(target);
  if (q.length === 0) return 0;

  // Exact match
  if (t === q) return 100;

  // Starts with
  if (t.startsWith(q)) return 80;

  // Contains
  if (t.includes(q)) return 60;

  // Fuzzy: consecutive character sequence
  let qi = 0;
  let consecutive = 0;
  let maxConsecutive = 0;
  for (let ti = 0; ti < t.length && qi < q.length; ti++) {
    if (t[ti] === q[qi]) {
      qi++;
      consecutive++;
      if (consecutive > maxConsecutive) maxConsecutive = consecutive;
    } else {
      consecutive = 0;
    }
  }

  if (qi === q.length) {
    // Score proportional to how much of the target was consumed consecutively
    return 30 + Math.round((maxConsecutive / q.length) * 30);
  }

  return 0;
}

/** Score a command item against a query, including keywords and description. */
function scoreCommand(item: CommandItem, query: string): number {
  let best = fuzzyScore(query, item.label);
  if (item.description) {
    best = Math.max(best, fuzzyScore(query, item.description));
  }
  if (item.keywords) {
    for (const kw of item.keywords) {
      best = Math.max(best, fuzzyScore(query, kw));
    }
  }
  return best;
}

// ─── Constants ────────────────────────────────────────────────────

const DEFAULT_GROUP_ID = '__default__';

const DEFAULT_COPY = {
  searchPlaceholder: '输入命令名称…',
  emptyTitle: '无可用命令',
  emptyHint: '暂无可用的命令。请检查命令配置。',
  noResultsTitle: '无匹配命令',
  noResultsHint: '未找到匹配「{query}」的命令，尝试更换关键词。',
  loadingLabel: '正在加载命令…',
  errorDefault: '加载命令失败，请重试。',
  retry: '重试',
  footerNavigate: '导航',
  footerSelect: '选择',
  footerDismiss: '关闭',
  shortcutEsc: 'ESC',
};

// ─── Component ─────────────────────────────────────────────────────

export default function CommandBar({
  isOpen,
  onClose,
  commands,
  groups = [],
  placeholder = DEFAULT_COPY.searchPlaceholder,
  enableGlobalShortcut = true,
  loading = false,
  error = '',
  onRetry,
  responsiveBand,
}: CommandBarProps) {
  const instanceId = useId().replace(/:/g, '');
  const searchInputRef = useRef<HTMLInputElement>(null);
  const listRef = useRef<HTMLDivElement>(null);
  const itemRefs = useRef<Map<string, HTMLButtonElement>>(new Map());
  const [query, setQuery] = useState('');
  const [activeIndex, setActiveIndex] = useState(0);
  const [mounted, setMounted] = useState(false);

  // ── Group map ──
  const groupOrderMap = useMemo(() => {
    const map = new Map<string, number>();
    groups.forEach((g, i) => map.set(g.id, i));
    return map;
  }, [groups]);

  // ── Filter + group commands ──
  const queryTrim = query.trim();
  const filtered = useMemo(() => {
    if (queryTrim.length === 0) return commands;

    const scored = commands.map((item) => ({
      item,
      score: scoreCommand(item, queryTrim),
    }));

    return scored
      .filter((entry) => entry.score > 0)
      .sort((a, b) => b.score - a.score)
      .map((entry) => entry.item);
  }, [commands, queryTrim]);

  const grouped = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const item of filtered) {
      const groupId = groupOrderMap.has(item.group) ? item.group : DEFAULT_GROUP_ID;
      const bucket = map.get(groupId);
      if (bucket) bucket.push(item);
      else map.set(groupId, [item]);
    }
    // Sort groups by defined order; default group last.
    const ordered: { groupId: string; label: string; items: CommandItem[] }[] = [];
    for (const g of groups) {
      const items = map.get(g.id);
      if (items && items.length > 0) {
        ordered.push({ groupId: g.id, label: g.label, items });
      }
    }
    const defaultItems = map.get(DEFAULT_GROUP_ID);
    if (defaultItems && defaultItems.length > 0) {
      ordered.push({ groupId: DEFAULT_GROUP_ID, label: '', items: defaultItems });
    }
    return ordered;
  }, [filtered, groups, groupOrderMap]);

  // Reset active index when query changes.
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setActiveIndex(0);
  }, [queryTrim]);

  // Mount animation tracking.
  useEffect(() => {
    if (isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setMounted(true);
      return () => {};
    }
    const timer = setTimeout(() => setMounted(false), 200);
    return () => clearTimeout(timer);
  }, [isOpen]);

  // Focus search input on open.
  useEffect(() => {
    if (!isOpen || loading) return;
    const timer = requestAnimationFrame(() => {
      searchInputRef.current?.focus();
    });
    return () => cancelAnimationFrame(timer);
  }, [isOpen, loading]);

  // Reset state on close.
  useEffect(() => {
    if (!isOpen) {
      // eslint-disable-next-line react-hooks/set-state-in-effect
      setQuery('');
      setActiveIndex(0);
    }
  }, [isOpen]);

  // ── Global Cmd/Ctrl+K shortcut ──
  useEffect(() => {
    if (!enableGlobalShortcut) return;

    function handleKeyDown(e: globalThis.KeyboardEvent) {
      const mod = e.metaKey || e.ctrlKey;
      if (mod && e.key.toLowerCase() === 'k' && !e.shiftKey) {
        e.preventDefault();
        if (isOpen) {
          onClose();
        }
        // The parent should toggle isOpen in response to onClose;
        // we don't set isOpen ourselves — it's a controlled prop.
      }
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => document.removeEventListener('keydown', handleKeyDown);
  }, [enableGlobalShortcut, isOpen, onClose]);

  // Flat list of all visible command IDs (for keyboard nav).
  const flatItemIds = useMemo(
    () => grouped.flatMap((g) => g.items.map((item) => item.id)),
    [grouped],
  );

  // ── Scroll active item into view ──
  const scrollToActive = useCallback(() => {
    const activeId = flatItemIds[activeIndex];
    const element = activeId ? itemRefs.current.get(activeId) : null;
    if (element && typeof element.scrollIntoView === 'function') {
      element.scrollIntoView({ block: 'nearest' });
    }
  }, [activeIndex, flatItemIds]);

  // ── Keyboard handler ──
  const handleSearchKeyDown = useCallback(
    (event: KeyboardEvent<HTMLInputElement>) => {
      if (event.key === 'Escape') {
        event.preventDefault();
        onClose();
        return;
      }

      if (event.key === 'ArrowDown') {
        event.preventDefault();
        setActiveIndex((current) => {
          // Skip disabled items
          let next = (current + 1) % Math.max(1, flatItemIds.length);
          let attempts = 0;
          while (attempts < flatItemIds.length) {
            const id = flatItemIds[next];
            const item = commands.find((c) => c.id === id);
            if (item && !item.disabled) break;
            next = (next + 1) % Math.max(1, flatItemIds.length);
            attempts++;
          }
          return next;
        });
        return;
      }

      if (event.key === 'ArrowUp') {
        event.preventDefault();
        setActiveIndex((current) => {
          let next = (current - 1 + Math.max(1, flatItemIds.length)) % Math.max(1, flatItemIds.length);
          let attempts = 0;
          while (attempts < flatItemIds.length) {
            const id = flatItemIds[next];
            const item = commands.find((c) => c.id === id);
            if (item && !item.disabled) break;
            next = (next - 1 + Math.max(1, flatItemIds.length)) % Math.max(1, flatItemIds.length);
            attempts++;
          }
          return next;
        });
        return;
      }

      if (event.key === 'Enter') {
        event.preventDefault();
        const activeId = flatItemIds[activeIndex];
        if (!activeId) return;
        const cmd = commands.find((c) => c.id === activeId);
        if (cmd && !cmd.disabled) {
          cmd.onExecute();
          onClose();
        }
        return;
      }
    },
    [onClose, flatItemIds, activeIndex, commands],
  );

  // Scroll when active index changes.
  useEffect(() => {
    scrollToActive();
  }, [activeIndex, scrollToActive]);

  // ── Render ──
  if (!isOpen && !mounted) return null;

  return (
    <div
      className={`command-bar-backdrop ${isOpen ? 'command-bar-backdrop--enter' : ''}`}
      role="dialog"
      aria-modal="true"
      aria-label="命令面板"
      data-responsive-band={responsiveBand}
      onClick={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className="command-bar-palette" onClick={(e) => e.stopPropagation()}>
        {/* ── Search bar ── */}
        <div className="command-bar-search">
          <span className="command-bar-search__icon" aria-hidden="true">
            <Search size={18} />
          </span>
          <input
            ref={searchInputRef}
            type="text"
            className="command-bar-search__input"
            value={query}
            onChange={(e) => setQuery(e.currentTarget.value)}
            onKeyDown={handleSearchKeyDown}
            placeholder={placeholder}
            aria-label="搜索命令"
            aria-autocomplete="list"
            aria-controls={`${instanceId}-command-list`}
            aria-activedescendant={
              flatItemIds[activeIndex]
                ? `${instanceId}-cmd-${flatItemIds[activeIndex]}`
                : undefined
            }
            role="combobox"
            aria-expanded={true}
            autoComplete="off"
            spellCheck={false}
          />
          <span className="command-bar-search__shortcut" aria-hidden="true">
            <CommandIcon size={14} />
            <kbd>K</kbd>
          </span>
        </div>

        {/* ── List body ── */}
        <div
          ref={listRef}
          id={`${instanceId}-command-list`}
          className="command-bar-list"
          role="listbox"
          aria-label="命令列表"
        >
          {/* Loading state */}
          {loading && (
            <div className="command-bar-loading" role="status" aria-live="polite">
              <LoaderCircle size={18} className="command-bar-loading__spinner" aria-hidden="true" />
              <span>{DEFAULT_COPY.loadingLabel}</span>
            </div>
          )}

          {/* Error state */}
          {!loading && error && (
            <div className="command-bar-error" role="alert">
              <AlertTriangle size={20} aria-hidden="true" />
              <span className="command-bar-error__message">{error}</span>
              {onRetry && (
                <button
                  type="button"
                  className="command-bar-error__retry"
                  onClick={onRetry}
                >
                  <RotateCcw size={14} aria-hidden="true" />
                  {DEFAULT_COPY.retry}
                </button>
              )}
            </div>
          )}

          {/* Empty state (no commands registered) */}
          {!loading && !error && commands.length === 0 && (
            <div className="command-bar-empty">
              <span className="command-bar-empty__icon" aria-hidden="true">
                <CommandIcon size={32} />
              </span>
              <span className="command-bar-empty__title">{DEFAULT_COPY.emptyTitle}</span>
              <span className="command-bar-empty__hint">{DEFAULT_COPY.emptyHint}</span>
            </div>
          )}

          {/* No results state */}
          {!loading && !error && commands.length > 0 && queryTrim.length > 0 && flatItemIds.length === 0 && (
            <div className="command-bar-no-results">
              <span className="command-bar-no-results__icon" aria-hidden="true">
                <Search size={32} />
              </span>
              <span className="command-bar-no-results__title">{DEFAULT_COPY.noResultsTitle}</span>
              <span className="command-bar-no-results__hint">
                {DEFAULT_COPY.noResultsHint.replace('{query}', queryTrim)}
              </span>
            </div>
          )}

          {/* Command groups */}
          {!loading && !error && grouped.map((group) => (
            <div key={group.groupId} role="group" aria-label={group.label || '其他命令'}>
              {group.label && (
                <div className="command-bar-group-label">{group.label}</div>
              )}
              {group.items.map((item) => {
                const flatIndex = flatItemIds.indexOf(item.id);
                const isActive = flatIndex === activeIndex;
                return (
                  <button
                    key={item.id}
                    ref={(element) => {
                      if (element) itemRefs.current.set(item.id, element); // eslint-disable-line react-hooks/refs
                      else itemRefs.current.delete(item.id);
                    }}
                    id={`${instanceId}-cmd-${item.id}`}
                    type="button"
                    className={`command-bar-item ${isActive ? 'is-active' : ''}`}
                    role="option"
                    aria-selected={isActive}
                    aria-disabled={item.disabled || undefined}
                    disabled={item.disabled}
                    tabIndex={-1}
                    onClick={() => {
                      if (!item.disabled) {
                        item.onExecute();
                        onClose();
                      }
                    }}
                    onMouseEnter={() => setActiveIndex(flatIndex)}
                  >
                    {item.icon && (
                      <span className="command-bar-item__icon" aria-hidden="true">
                        <item.icon size={16} />
                      </span>
                    )}
                    {!item.icon && <span />}
                    <span className="command-bar-item__copy">
                      <span className="command-bar-item__label">{item.label}</span>
                      {item.description && (
                        <span className="command-bar-item__description">{item.description}</span>
                      )}
                    </span>
                    {item.shortcut && (
                      <span className="command-bar-item__shortcut" aria-hidden="true">
                        {item.shortcut}
                      </span>
                    )}
                  </button>
                );
              })}
            </div>
          ))}
        </div>

        {/* ── Footer hints ── */}
        {!loading && !error && (
          <div className="command-bar-footer">
            <div className="command-bar-footer__hints">
              <span className="command-bar-footer__hint">
                <kbd aria-hidden="true">
                  <ArrowUp size={10} />
                </kbd>
                <kbd aria-hidden="true">
                  <ArrowDown size={10} />
                </kbd>
                <span>{DEFAULT_COPY.footerNavigate}</span>
              </span>
              <span className="command-bar-footer__hint">
                <kbd aria-hidden="true">
                  <CornerDownLeft size={10} />
                </kbd>
                <span>{DEFAULT_COPY.footerSelect}</span>
              </span>
              <span className="command-bar-footer__hint">
                <kbd>{DEFAULT_COPY.shortcutEsc}</kbd>
                <span>{DEFAULT_COPY.footerDismiss}</span>
              </span>
            </div>
            {flatItemIds.length > 0 && (
              <span className="command-bar-footer__count" aria-live="polite">
                {activeIndex + 1}/{flatItemIds.length}
              </span>
            )}
          </div>
        )}
      </div>
    </div>
  );
}

export { DEFAULT_COPY };
