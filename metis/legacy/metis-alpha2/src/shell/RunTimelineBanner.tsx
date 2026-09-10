/**
 * RunTimelineBanner — fixed-top banner showing recent execution runs.
 *
 * Displays a timeline of recent run records with status indicators, progress bars,
 * and actions to view, resume, or terminate a run. Supports loading, empty, error,
 * and recovery states. Built for the Metis ProjectShell and follows the research
 * workspace visual language (METIS-501/507).
 *
 * Accessibility:
 *   - Keyboard arrow navigation between run items (RTL-aware).
 *   - Focus-visible rings matching the shell focus style.
 *   - Reduced-motion and forced-colors support.
 */

import {
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  useState,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  AlertCircle,
  CheckCircle2,
  ChevronRight,
  Loader2,
  Play,
  RotateCcw,
  Square,
  Terminal,
  X,
} from 'lucide-react';
import './RunTimelineBanner.css';

export type RunStatus =
  | 'running'
  | 'pending'
  | 'completed'
  | 'failed'
  | 'terminated'
  | 'recoverable';

export interface RunRecord {
  id: string;
  title: string;
  status: RunStatus;
  /** Progress percentage from 0 to 100. */
  progress?: number;
  /** ISO timestamp or Date when the run started. */
  startedAt?: string | Date;
  /** ISO timestamp or Date of the last update. */
  updatedAt?: string | Date;
  /** Optional short status or error message. */
  message?: string;
}

export interface RunTimelineBannerProps {
  /** Recent run records to display (newest first). */
  runs: RunRecord[];
  /** Whether the run list is still loading. */
  isLoading?: boolean;
  /** Error to display; renders the error state when non-null. */
  error?: Error | string | null;
  /** Callback to retry loading runs or recover from an error. */
  onRetry?: () => void;
  /** Resume a recoverable run. */
  onResume?: (runId: string) => void;
  /** Open the full details/logs for a run. */
  onView?: (runId: string) => void;
  /** Terminate a running/pending run. */
  onTerminate?: (runId: string) => void;
  /** Dismiss the entire banner. */
  onDismiss?: () => void;
  /** Maximum number of recent runs visible before "show more". */
  maxVisible?: number;
  /** Optional additional class name. */
  className?: string;
  /** Optional accessible label override. */
  'aria-label'?: string;
}

const STATUS_LABELS: Record<RunStatus, string> = {
  running: '运行中',
  pending: '等待中',
  completed: '已完成',
  failed: '失败',
  terminated: '已终止',
  recoverable: '可恢复',
};

const STATUS_ORDER: RunStatus[] = [
  'running',
  'pending',
  'recoverable',
  'failed',
  'terminated',
  'completed',
];

function formatTime(value?: string | Date): string {
  if (!value) return '';
  const date = typeof value === 'string' ? new Date(value) : value;
  if (Number.isNaN(date.getTime())) return '';
  return date.toLocaleString(undefined, {
    month: 'short',
    day: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

function clampProgress(value?: number): number {
  if (value === undefined || Number.isNaN(value)) return 0;
  return Math.max(0, Math.min(100, value));
}

function getErrorMessage(error: Error | string | null | undefined): string {
  if (!error) return '加载执行记录时出错';
  if (typeof error === 'string') return error;
  return error.message || '加载执行记录时出错';
}

function sortRunsByStatusAndRecency(a: RunRecord, b: RunRecord): number {
  const statusDiff = STATUS_ORDER.indexOf(a.status) - STATUS_ORDER.indexOf(b.status);
  if (statusDiff !== 0) return statusDiff;
  const aTime = a.updatedAt ? new Date(a.updatedAt).getTime() : 0;
  const bTime = b.updatedAt ? new Date(b.updatedAt).getTime() : 0;
  return bTime - aTime;
}

export default function RunTimelineBanner({
  runs,
  isLoading = false,
  error = null,
  onRetry,
  onResume,
  onView,
  onTerminate,
  onDismiss,
  maxVisible = 3,
  className = '',
  'aria-label': ariaLabel,
}: RunTimelineBannerProps) {
  const instanceId = useId().replace(/:/g, '');
  const bannerRef = useRef<HTMLDivElement>(null);
  const listRef = useRef<HTMLUListElement>(null);
  const [activeIndex, setActiveIndex] = useState(0);
  const [expanded, setExpanded] = useState(false);

  const sortedRuns = useMemo(() => [...runs].sort(sortRunsByStatusAndRecency), [runs]);
  const visibleRuns = expanded ? sortedRuns : sortedRuns.slice(0, maxVisible);
  const recoverableCount = useMemo(
    () => sortedRuns.filter((run) => run.status === 'recoverable' || run.status === 'failed').length,
    [sortedRuns],
  );
  const hasLiveRuns = sortedRuns.some((run) => run.status === 'running' || run.status === 'pending');

  const itemRefs = useRef<(HTMLLIElement | null)[]>([]);
  useEffect(() => {
    itemRefs.current = itemRefs.current.slice(0, visibleRuns.length);
  }, [visibleRuns.length]);

  const focusItem = useCallback((index: number) => {
    const item = itemRefs.current[index];
    if (item) {
      item.focus();
      setActiveIndex(index);
    }
  }, []);

  const handleItemKeyDown = useCallback(
    (event: KeyboardEvent<HTMLLIElement>, index: number) => {
      const rtl = bannerRef.current
        ? getComputedStyle(bannerRef.current).direction === 'rtl'
        : false;
      let nextIndex: number | null = null;

      if (event.key === 'ArrowRight') {
        nextIndex = (index + (rtl ? -1 : 1) + visibleRuns.length) % visibleRuns.length;
      } else if (event.key === 'ArrowLeft') {
        nextIndex = (index + (rtl ? 1 : -1) + visibleRuns.length) % visibleRuns.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = visibleRuns.length - 1;
      } else if (event.key === 'Enter' || event.key === ' ') {
        event.preventDefault();
        onView?.(visibleRuns[index]?.id ?? '');
        return;
      } else if ((event.key === 'Delete' || event.key === 'Backspace') && onTerminate) {
        const run = visibleRuns[index];
        if (run && (run.status === 'running' || run.status === 'pending')) {
          event.preventDefault();
          onTerminate(run.id);
        }
        return;
      } else if ((event.key === 'r' || event.key === 'R') && onResume) {
        const run = visibleRuns[index];
        if (run && (run.status === 'recoverable' || run.status === 'failed')) {
          event.preventDefault();
          onResume(run.id);
        }
        return;
      }

      if (nextIndex !== null) {
        event.preventDefault();
        focusItem(nextIndex);
      }
    },
    [focusItem, onResume, onTerminate, onView, visibleRuns],
  );

  const handleListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLUListElement>) => {
      if (event.key === 'ArrowDown' && visibleRuns.length > 0) {
        event.preventDefault();
        focusItem(0);
      }
    },
    [focusItem, visibleRuns.length],
  );

  const renderStatusDot = (status: RunStatus): ReactNode => {
    const label = STATUS_LABELS[status];
    return (
      <span
        className={`run-timeline-banner__status run-timeline-banner__status--${status}`}
        aria-label={label}
        title={label}
      >
        <span className="run-timeline-banner__status-dot" aria-hidden="true" />
      </span>
    );
  };

  const renderProgress = (run: RunRecord): ReactNode => {
    if (run.status !== 'running' && run.status !== 'pending') return null;
    const progress = clampProgress(run.progress);
    return (
      <span
        className="run-timeline-banner__progress"
        role="progressbar"
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={progress}
        aria-label={`${run.title} 进度 ${progress}%`}
      >
        <span className="run-timeline-banner__progress-track" aria-hidden="true">
          <span
            className="run-timeline-banner__progress-fill"
            style={{ transform: `scaleX(${progress / 100})` }}
          />
        </span>
        <span className="run-timeline-banner__progress-value">{progress}%</span>
      </span>
    );
  };

  const renderRunActions = (run: RunRecord): ReactNode => {
    const commonButtonClass = 'run-timeline-banner__action';
    return (
      <span className="run-timeline-banner__actions">
        {(run.status === 'recoverable' || run.status === 'failed') && onResume && (
          <button
            type="button"
            className={`${commonButtonClass} run-timeline-banner__action--resume`}
            onClick={() => onResume(run.id)}
            aria-label={`恢复运行 ${run.title}`}
            title="恢复运行 (R)"
          >
            <RotateCcw size={13} aria-hidden="true" />
            <span>恢复</span>
          </button>
        )}
        {(run.status === 'running' || run.status === 'pending') && onTerminate && (
          <button
            type="button"
            className={`${commonButtonClass} run-timeline-banner__action--terminate`}
            onClick={() => onTerminate(run.id)}
            aria-label={`终止运行 ${run.title}`}
            title="终止运行 (Delete)"
          >
            <Square size={13} aria-hidden="true" />
            <span>终止</span>
          </button>
        )}
        {onView && (
          <button
            type="button"
            className={`${commonButtonClass} run-timeline-banner__action--view`}
            onClick={() => onView(run.id)}
            aria-label={`查看运行 ${run.title}`}
            title="查看详情 (Enter)"
          >
            <Terminal size={13} aria-hidden="true" />
            <span>查看</span>
          </button>
        )}
      </span>
    );
  };

  const renderLoading = (): ReactNode => (
    <div className="run-timeline-banner__state run-timeline-banner__state--loading">
      <Loader2 size={16} className="run-timeline-banner__spinner" aria-hidden="true" />
      <span>正在加载执行记录…</span>
    </div>
  );

  const renderEmpty = (): ReactNode => (
    <div className="run-timeline-banner__state run-timeline-banner__state--empty">
      <CheckCircle2 size={16} aria-hidden="true" />
      <span>暂无近期执行记录</span>
    </div>
  );

  const renderError = (): ReactNode => (
    <div className="run-timeline-banner__state run-timeline-banner__state--error">
      <AlertCircle size={16} aria-hidden="true" />
      <span className="run-timeline-banner__error-text">{getErrorMessage(error)}</span>
      {onRetry && (
        <button
          type="button"
          className="run-timeline-banner__retry"
          onClick={onRetry}
          aria-label="重试加载执行记录"
        >
          重试
        </button>
      )}
    </div>
  );

  const renderRecovery = (): ReactNode | null => {
    if (recoverableCount === 0 || !onResume) return null;
    return (
      <div className="run-timeline-banner__recovery">
        <RotateCcw size={14} aria-hidden="true" />
        <span>
          检测到 {recoverableCount} 个可恢复运行。您可以单独恢复每个运行，或
          <button
            type="button"
            className="run-timeline-banner__recover-all"
            onClick={() => {
              sortedRuns
                .filter((run) => run.status === 'recoverable' || run.status === 'failed')
                .forEach((run) => onResume?.(run.id));
            }}
            aria-label="恢复所有可恢复运行"
          >
            全部恢复
          </button>
          。
        </span>
      </div>
    );
  };

  const body = (() => {
    if (isLoading) return renderLoading();
    if (error) return renderError();
    if (sortedRuns.length === 0) return renderEmpty();
    return null;
  })();

  return (
    <div
      ref={bannerRef}
      className={`run-timeline-banner ${className}`.trim()}
      role="region"
      aria-label={ariaLabel || '执行时间线'}
      aria-live={hasLiveRuns ? 'polite' : undefined}
      aria-atomic={hasLiveRuns ? 'false' : undefined}
    >
      <div className="run-timeline-banner__header">
        <div className="run-timeline-banner__title">
          <span className="run-timeline-banner__icon" aria-hidden="true">
            <Play size={14} />
          </span>
          <span>执行时间线</span>
          {sortedRuns.length > 0 && (
            <span className="run-timeline-banner__count" aria-label={`${sortedRuns.length} 条记录`}>
              {sortedRuns.length}
            </span>
          )}
        </div>
        <div className="run-timeline-banner__header-actions">
          {sortedRuns.length > maxVisible && (
            <button
              type="button"
              className="run-timeline-banner__toggle"
              onClick={() => setExpanded((prev) => !prev)}
              aria-expanded={expanded}
              aria-controls={`${instanceId}-run-timeline-list`}
            >
              <span>{expanded ? '收起' : '展开'}</span>
              <ChevronRight
                size={14}
                className={`run-timeline-banner__toggle-icon ${expanded ? 'is-expanded' : ''}`}
                aria-hidden="true"
              />
            </button>
          )}
          {onDismiss && (
            <button
              type="button"
              className="run-timeline-banner__dismiss"
              onClick={onDismiss}
              aria-label="关闭执行时间线横幅"
              title="关闭"
            >
              <X size={14} aria-hidden="true" />
            </button>
          )}
        </div>
      </div>

      {renderRecovery()}

      {body ? (
        <div className="run-timeline-banner__body">{body}</div>
      ) : (
        <div className="run-timeline-banner__body">
          <ul
            ref={listRef}
            id={`${instanceId}-run-timeline-list`}
            className="run-timeline-banner__list"
            role="list"
            aria-label="最近执行记录"
            onKeyDown={handleListKeyDown}
          >
            {visibleRuns.map((run, index) => (
              <li
                key={run.id}
                ref={(element) => { itemRefs.current[index] = element; }}
                className={`run-timeline-banner__item run-timeline-banner__item--${run.status}`}
                role="listitem"
                tabIndex={activeIndex === index ? 0 : -1}
                aria-label={`${run.title}，${STATUS_LABELS[run.status]}`}
                onKeyDown={(event) => handleItemKeyDown(event, index)}
                onFocus={() => setActiveIndex(index)}
              >
                <span className="run-timeline-banner__connector" aria-hidden="true" />
                {renderStatusDot(run.status)}
                <div className="run-timeline-banner__content">
                  <div className="run-timeline-banner__row">
                    <span className="run-timeline-banner__name" title={run.title}>
                      {run.title}
                    </span>
                    {renderRunActions(run)}
                  </div>
                  <div className="run-timeline-banner__meta">
                    {run.message && (
                      <span className="run-timeline-banner__message" title={run.message}>
                        {run.message}
                      </span>
                    )}
                    {run.updatedAt && (
                      <time className="run-timeline-banner__time" dateTime={new Date(run.updatedAt).toISOString()}>
                        {formatTime(run.updatedAt)}
                      </time>
                    )}
                  </div>
                  {renderProgress(run)}
                </div>
              </li>
            ))}
          </ul>
          {!expanded && sortedRuns.length > maxVisible && (
            <div className="run-timeline-banner__more">
              <button
                type="button"
                className="run-timeline-banner__more-button"
                onClick={() => setExpanded(true)}
                aria-expanded={false}
                aria-controls={`${instanceId}-run-timeline-list`}
              >
                还有 {sortedRuns.length - maxVisible} 条记录
              </button>
            </div>
          )}
        </div>
      )}
    </div>
  );
}

export { STATUS_LABELS, STATUS_ORDER };
