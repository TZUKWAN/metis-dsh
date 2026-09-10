/**
 * VersionDiffReviewer — version list, inline/side-by-side diff, and review workflow.
 *
 * Features:
 *   - Select base / target versions from a scrollable version list
 *   - Line-level text diff rendered inline or side-by-side
 *   - Review comment list with add / resolve / select actions
 *   - Approve / reject / request-changes actions exposed as prop callbacks
 *   - Keyboard navigation (arrow keys in lists, Enter to select, Escape to clear)
 *   - RTL-aware layout via CSS logical properties
 *   - Loading, empty, error/recovery, and "select versions" placeholder states
 *   - Supports 200% zoom, forced-colors mode, and prefers-reduced-motion
 *   - Responsive band detection via data-responsive-band
 *
 * All backend-dependent actions (version selection, review CRUD, workflow actions)
 * are exposed as prop callbacks; no results are faked.
 */

import {
  useState,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useRef,
  type KeyboardEvent,
  type ReactNode,
} from 'react';
import {
  GitCompare,
  Columns2,
  FileText,
  Loader2,
  AlertCircle,
  RefreshCw,
  ChevronDown,
  Plus,
  Check,
  CheckCircle2,
  XCircle,
  ListFilter,
  History,
  MessageSquareWarning,
} from 'lucide-react';
import './VersionDiffReviewer.css';
import ArtifactVersionReviewActions from './ArtifactVersionReviewActions';

export type VersionStatus = 'draft' | 'submitted' | 'approved' | 'rejected' | 'changes_requested';

export interface VersionItem {
  id: string;
  label: string;
  author?: string;
  createdAt?: string;
  status?: VersionStatus;
  /** Full text content of this version. */
  content: string;
}

export interface ReviewComment {
  id: string;
  line?: number;
  author?: string;
  createdAt?: string;
  text: string;
  resolved?: boolean;
}

export type DiffViewMode = 'inline' | 'sideBySide';

type DiffType = 'equal' | 'insert' | 'delete' | 'replace';

interface DiffChunk {
  type: DiffType;
  baseLines: string[];
  targetLines: string[];
  baseStart: number;
  targetStart: number;
}

export interface VersionDiffReviewerProps {
  /** Available versions to compare and review. */
  versions: VersionItem[];
  /** Existing review comments for the active comparison. */
  reviews?: ReviewComment[];
  /** Currently selected review comment id (controlled). */
  activeReviewId?: string | null;
  /** Base version id (controlled). */
  baseVersionId?: string | null;
  /** Target version id (controlled). */
  targetVersionId?: string | null;
  /** Current diff view mode (controlled). */
  viewMode?: DiffViewMode;
  /** Show a global loading overlay. */
  loading?: boolean;
  /** Error message to display with an optional retry action. */
  error?: string | null;
  /** Extra class names for the root element. */
  className?: string;
  /** Retry callback; shown when error is provided. */
  onRetry?: () => void;
  /** Called when the base version changes. */
  onBaseVersionChange?: (id: string) => void;
  /** Called when the target version changes. */
  onTargetVersionChange?: (id: string) => void;
  /** Called when the view mode changes. */
  onViewModeChange?: (mode: DiffViewMode) => void;
  /** Called when a review comment is selected or deselected. */
  onReviewSelect?: (id: string | null) => void;
  /** Called when the user submits a new review comment. */
  onAddReviewComment?: (comment: { line?: number; text: string }) => void;
  /** Called when a review comment's resolved state changes. */
  onResolveReview?: (id: string, resolved: boolean) => void;
  /** Called when the user approves the target version. */
  onApprove?: () => void;
  /** Called when the user rejects the target version. */
  onReject?: () => void;
  /** Called when the user requests changes to the target version. */
  onRequestChanges?: () => void;
}

const VIEW_MODE_LABELS: Record<DiffViewMode, string> = {
  inline: '行内',
  sideBySide: '并排',
};

/**
 * Compute a line-level diff between two texts using a simple LCS.
 * Adjacent delete + insert chunks are merged into a single replace chunk.
 */
function computeLineDiff(baseText: string, targetText: string): DiffChunk[] {
  const base = baseText.split('\n');
  const target = targetText.split('\n');
  const m = base.length;
  const n = target.length;

  if (m === 0 && n === 0) return [];
  if (m === 0) {
    return [{ type: 'insert', baseLines: [], targetLines: target, baseStart: 0, targetStart: 0 }];
  }
  if (n === 0) {
    return [{ type: 'delete', baseLines: base, targetLines: [], baseStart: 0, targetStart: 0 }];
  }

  const dp: number[][] = Array.from({ length: m + 1 }, () => Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    const baseLine = base[i - 1];
    if (baseLine === undefined) continue;
    for (let j = 1; j <= n; j++) {
      const targetLine = target[j - 1];
      if (targetLine === undefined) continue;
      if (baseLine === targetLine) {
        dp[i]![j] = dp[i - 1]![j - 1]! + 1;
      } else {
        dp[i]![j] = Math.max(dp[i - 1]![j]!, dp[i]![j - 1]!);
      }
    }
  }

  const chunks: DiffChunk[] = [];
  let i = m;
  let j = n;

  while (i > 0 || j > 0) {
    const baseLine = i > 0 ? base[i - 1] : undefined;
    const targetLine = j > 0 ? target[j - 1] : undefined;

    if (baseLine !== undefined && targetLine !== undefined && baseLine === targetLine) {
      const equalLines: string[] = [baseLine];
      const baseStart = i - 1;
      const targetStart = j - 1;
      i--; j--;
      while (i > 0 && j > 0) {
        const bl = base[i - 1];
        const tl = target[j - 1];
        if (bl === undefined || tl === undefined || bl !== tl) break;
        equalLines.unshift(bl);
        i--; j--;
      }
      chunks.unshift({
        type: 'equal',
        baseLines: equalLines,
        targetLines: [...equalLines],
        baseStart,
        targetStart,
      });
    } else if (targetLine !== undefined && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
      const targetStart = j - 1;
      const insertLines: string[] = [targetLine];
      j--;
      while (j > 0 && (i === 0 || dp[i]![j - 1]! >= dp[i - 1]![j]!)) {
        const tl = target[j - 1];
        if (tl === undefined) break;
        insertLines.unshift(tl);
        j--;
      }
      chunks.unshift({
        type: 'insert',
        baseLines: [],
        targetLines: insertLines,
        baseStart: i,
        targetStart,
      });
    } else if (baseLine !== undefined) {
      const baseStart = i - 1;
      const deleteLines: string[] = [baseLine];
      i--;
      while (i > 0 && (j === 0 || dp[i - 1]![j]! > dp[i]![j - 1]!)) {
        const bl = base[i - 1];
        if (bl === undefined) break;
        deleteLines.unshift(bl);
        i--;
      }
      chunks.unshift({
        type: 'delete',
        baseLines: deleteLines,
        targetLines: [],
        baseStart,
        targetStart: j,
      });
    }
  }

  // Merge adjacent delete + insert into replace.
  const merged: DiffChunk[] = [];
  for (const chunk of chunks) {
    const last = merged[merged.length - 1];
    if (last && last.type === 'delete' && chunk.type === 'insert') {
      last.type = 'replace';
      last.targetLines = chunk.targetLines;
    } else {
      merged.push({ ...chunk });
    }
  }

  return merged;
}

function classNames(...values: (string | false | undefined)[]): string {
  return values.filter(Boolean).join(' ');
}

export default function VersionDiffReviewer({
  versions,
  reviews = [],
  activeReviewId: controlledActiveReviewId,
  baseVersionId: controlledBaseVersionId,
  targetVersionId: controlledTargetVersionId,
  viewMode: controlledViewMode,
  loading = false,
  error = null,
  className = '',
  onRetry,
  onBaseVersionChange,
  onTargetVersionChange,
  onViewModeChange,
  onReviewSelect,
  onAddReviewComment,
  onResolveReview,
  onApprove,
  onReject,
  onRequestChanges,
}: VersionDiffReviewerProps) {
  const instanceId = useId().replace(/:/g, '');
  const rootRef = useRef<HTMLDivElement>(null);
  const versionListRef = useRef<HTMLDivElement>(null);
  const diffScrollRef = useRef<HTMLDivElement>(null);
  const reviewListRef = useRef<HTMLDivElement>(null);
  const commentInputRef = useRef<HTMLTextAreaElement>(null);

  const [uncontrolledBaseVersionId, setUncontrolledBaseVersionId] = useState<string | null>(null);
  const [uncontrolledTargetVersionId, setUncontrolledTargetVersionId] = useState<string | null>(null);
  const [uncontrolledViewMode, setUncontrolledViewMode] = useState<DiffViewMode>('inline');
  const [uncontrolledActiveReviewId, setUncontrolledActiveReviewId] = useState<string | null>(null);
  const [resolvedBand, setResolvedBand] = useState<'wide' | 'medium' | 'narrow'>('wide');
  const [commentDraft, setCommentDraft] = useState('');
  const [commentLine, setCommentLine] = useState<number | undefined>(undefined);
  const liveRegionRef = useRef<HTMLDivElement>(null);

  const announce = useCallback((message: string) => {
    if (liveRegionRef.current) {
      liveRegionRef.current.textContent = message;
    }
  }, []);

  const baseVersionId = controlledBaseVersionId ?? uncontrolledBaseVersionId;
  const targetVersionId = controlledTargetVersionId ?? uncontrolledTargetVersionId;
  const viewMode = controlledViewMode ?? uncontrolledViewMode;
  const activeReviewId = controlledActiveReviewId ?? uncontrolledActiveReviewId;

  const baseVersion = useMemo(
    () => versions.find((v) => v.id === baseVersionId) ?? null,
    [versions, baseVersionId],
  );
  const targetVersion = useMemo(
    () => versions.find((v) => v.id === targetVersionId) ?? null,
    [versions, targetVersionId],
  );

  const diffChunks = useMemo(() => {
    if (!baseVersion || !targetVersion) return [];
    return computeLineDiff(baseVersion.content, targetVersion.content);
  }, [baseVersion, targetVersion]);

  // Responsive band detection.
  useEffect(() => {
    const root = rootRef.current;
    if (!root) return;

    const updateBand = () => {
      const width = root.clientWidth;
      if (width <= 0) return;
      const nextBand = width <= 640 ? 'narrow' : width <= 1100 ? 'medium' : 'wide';
      setResolvedBand((prev) => (prev === nextBand ? prev : nextBand));
    };

    updateBand();
    const observer = new ResizeObserver(updateBand);
    observer.observe(root);
    return () => observer.disconnect();
  }, []);

  // Announce diff summary when comparison changes.
  useEffect(() => {
    if (!baseVersion || !targetVersion) return;
    const insertions = diffChunks.reduce(
      (sum, chunk) => sum + (chunk.type === 'insert' ? chunk.targetLines.length : chunk.type === 'replace' ? chunk.targetLines.length : 0),
      0,
    );
    const deletions = diffChunks.reduce(
      (sum, chunk) => sum + (chunk.type === 'delete' ? chunk.baseLines.length : chunk.type === 'replace' ? chunk.baseLines.length : 0),
      0,
    );
    announce(
      `已对比 ${baseVersion.label} 与 ${targetVersion.label}，新增 ${insertions} 行，删除 ${deletions} 行。`,
    );
  }, [baseVersion, targetVersion, diffChunks, announce]);

  const setBaseVersionId = useCallback(
    (id: string) => {
      if (controlledBaseVersionId === undefined) setUncontrolledBaseVersionId(id);
      onBaseVersionChange?.(id);
    },
    [controlledBaseVersionId, onBaseVersionChange],
  );

  const setTargetVersionId = useCallback(
    (id: string) => {
      if (controlledTargetVersionId === undefined) setUncontrolledTargetVersionId(id);
      onTargetVersionChange?.(id);
    },
    [controlledTargetVersionId, onTargetVersionChange],
  );

  const setViewMode = useCallback(
    (mode: DiffViewMode) => {
      if (controlledViewMode === undefined) setUncontrolledViewMode(mode);
      onViewModeChange?.(mode);
      announce(`差异视图已切换为${VIEW_MODE_LABELS[mode]}模式`);
    },
    [controlledViewMode, onViewModeChange, announce],
  );

  const setActiveReviewId = useCallback(
    (id: string | null) => {
      if (controlledActiveReviewId === undefined) setUncontrolledActiveReviewId(id);
      onReviewSelect?.(id);
    },
    [controlledActiveReviewId, onReviewSelect],
  );

  const handleAddComment = useCallback(() => {
    const text = commentDraft.trim();
    if (!text || !onAddReviewComment) return;
    onAddReviewComment({ line: commentLine, text });
    setCommentDraft('');
    setCommentLine(undefined);
    announce('批注已提交');
    commentInputRef.current?.focus();
  }, [commentDraft, commentLine, onAddReviewComment, announce]);

  const handleResolveReview = useCallback(
    (id: string, resolved: boolean) => {
      onResolveReview?.(id, resolved);
      announce(resolved ? '批注已标记为已解决' : '批注已标记为未解决');
    },
    [onResolveReview, announce],
  );

  // Keyboard navigation for the version list.
  const handleVersionListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const items = versions.map((v) => v.id);
      const focusIndex = items.findIndex((id) => document.activeElement?.getAttribute('data-version-id') === id);
      let nextIndex: number;

      if (event.key === 'ArrowDown') {
        nextIndex = focusIndex < 0 ? 0 : (focusIndex + 1) % items.length;
      } else if (event.key === 'ArrowUp') {
        nextIndex = focusIndex < 0 ? items.length - 1 : (focusIndex - 1 + items.length) % items.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = items.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const nextId = items[nextIndex];
      const nextButton = versionListRef.current?.querySelector<HTMLElement>(`[data-version-id="${nextId}"]`);
      nextButton?.focus();
    },
    [versions],
  );

  // Keyboard navigation for the review list.
  const handleReviewListKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      const items = reviews.map((r) => r.id);
      const focusIndex = items.findIndex((id) => document.activeElement?.getAttribute('data-review-id') === id);
      let nextIndex: number;

      if (event.key === 'ArrowDown') {
        nextIndex = focusIndex < 0 ? 0 : (focusIndex + 1) % items.length;
      } else if (event.key === 'ArrowUp') {
        nextIndex = focusIndex < 0 ? items.length - 1 : (focusIndex - 1 + items.length) % items.length;
      } else if (event.key === 'Home') {
        nextIndex = 0;
      } else if (event.key === 'End') {
        nextIndex = items.length - 1;
      } else {
        return;
      }

      event.preventDefault();
      const nextId = items[nextIndex];
      const nextButton = reviewListRef.current?.querySelector<HTMLElement>(`[data-review-id="${nextId}"]`);
      nextButton?.focus();
    },
    [reviews],
  );

  const handleDiffKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'Escape') {
        setActiveReviewId(null);
        setCommentLine(undefined);
      }
    },
    [setActiveReviewId],
  );

  const handleDiffLineClick = useCallback(
    (lineNumber: number) => {
      setCommentLine(lineNumber);
      setActiveReviewId(null);
      commentInputRef.current?.focus();
    },
    [setActiveReviewId],
  );

  const renderStatusDot = (status?: VersionStatus) => {
    if (!status) return null;
    return (
      <span
        className={classNames('version-diff-reviewer__status-dot', status && `is-${status}`)}
        aria-hidden="true"
      />
    );
  };

  const renderEmpty = (icon: ReactNode, title: string, message: string) => (
    <div className="version-diff-reviewer__empty" role="status" aria-live="polite">
      <div className="version-diff-reviewer__empty-icon">{icon}</div>
      <strong className="version-diff-reviewer__empty-title">{title}</strong>
      <span className="version-diff-reviewer__empty-message">{message}</span>
    </div>
  );

  const renderError = () =>
    error && (
      <div className="version-diff-reviewer__error" role="alert">
        <AlertCircle size={16} aria-hidden="true" className="version-diff-reviewer__error-icon" />
        <span className="version-diff-reviewer__error-text">{error}</span>
        {onRetry && (
          <button
            type="button"
            className="version-diff-reviewer__retry-btn"
            onClick={onRetry}
            aria-label="重试"
          >
            <RefreshCw size={13} aria-hidden="true" />
            <span>重试</span>
          </button>
        )}
      </div>
    );

  const renderLoading = () => (
    <div className="version-diff-reviewer__loading" role="status" aria-live="polite">
      <Loader2 size={22} aria-hidden="true" className="version-diff-reviewer__spinner" />
      <span>加载差异与审阅数据中…</span>
    </div>
  );

  const renderVersionList = () => {
    if (versions.length === 0) {
      return renderEmpty(
        <History size={24} aria-hidden="true" />,
        '暂无版本',
        '当前项目还没有保存任何版本。',
      );
    }

    return (
      <div
        ref={versionListRef}
        className="version-diff-reviewer__version-list"
        role="radiogroup"
        aria-label="版本列表"
        onKeyDown={handleVersionListKeyDown}
      >
        {versions.map((version) => {
          const isBase = version.id === baseVersionId;
          const isTarget = version.id === targetVersionId;
          const isSelected = isBase || isTarget;
          const selectionLabel = isBase && isTarget ? '基线/目标' : isBase ? '基线' : isTarget ? '目标' : '';

          return (
            <div
              key={version.id}
              className={classNames(
                'version-diff-reviewer__version-item',
                isSelected && 'is-selected',
                activeReviewId === version.id && 'is-active-review',
              )}
            >
              <button
                type="button"
                data-version-id={version.id}
                className={classNames(
                  'version-diff-reviewer__version-row',
                  isSelected && 'is-selected',
                )}
                onClick={() => {
                  if (baseVersionId && baseVersionId !== version.id && targetVersionId !== version.id) {
                    setTargetVersionId(version.id);
                  } else {
                    setBaseVersionId(version.id);
                    if (targetVersionId === version.id) setTargetVersionId('');
                  }
                }}
                aria-label={`选择版本 ${version.label}${version.author ? `，作者 ${version.author}` : ''}`}
              >
                <span className="version-diff-reviewer__version-glyph">
                  {renderStatusDot(version.status)}
                  <span className="version-diff-reviewer__version-label">{version.label}</span>
                </span>
                <span className="version-diff-reviewer__version-meta">
                  {selectionLabel && (
                    <span className="version-diff-reviewer__version-badge">{selectionLabel}</span>
                  )}
                  {version.author && (
                    <span className="version-diff-reviewer__version-author">{version.author}</span>
                  )}
                  {version.createdAt && (
                    <span className="version-diff-reviewer__version-date">{version.createdAt}</span>
                  )}
                </span>
              </button>
              <div className="version-diff-reviewer__version-actions">
                <button
                  type="button"
                  className={classNames(
                    'version-diff-reviewer__version-chip',
                    isBase && 'is-active',
                  )}
                  onClick={() => setBaseVersionId(version.id)}
                  aria-pressed={isBase}
                  aria-label={`将 ${version.label} 设为基线`}
                  title="设为基线"
                >
                  基线
                </button>
                <button
                  type="button"
                  className={classNames(
                    'version-diff-reviewer__version-chip',
                    isTarget && 'is-active',
                  )}
                  onClick={() => setTargetVersionId(version.id)}
                  aria-pressed={isTarget}
                  aria-label={`将 ${version.label} 设为目标`}
                  title="设为目标"
                >
                  目标
                </button>
              </div>
            </div>
          );
        })}
      </div>
    );
  };

  const renderInlineDiff = () => {
    if (!baseVersion || !targetVersion) return null;
    if (diffChunks.length === 0) {
      return renderEmpty(
        <CheckCircle2 size={24} aria-hidden="true" />,
        '内容相同',
        '两个版本的文本完全一致。',
      );
    }

    let baseLineNumber = 1;
    let targetLineNumber = 1;

    return (
      <div className="version-diff-reviewer__diff-table" role="table" aria-label="行内差异">
        <div role="rowgroup">
          {diffChunks.map((chunk, chunkIndex) => {
            const rows: ReactNode[] = [];
            const maxLines = Math.max(chunk.baseLines.length, chunk.targetLines.length);

            for (let lineIndex = 0; lineIndex < maxLines; lineIndex++) {
              const baseLine = chunk.baseLines[lineIndex];
              const targetLine = chunk.targetLines[lineIndex];
              const type = chunk.type;
              const currentBaseLine = baseLine !== undefined ? baseLineNumber++ : undefined;
              const currentTargetLine = targetLine !== undefined ? targetLineNumber++ : undefined;
              const isActiveLine = commentLine === (currentTargetLine ?? currentBaseLine);

              rows.push(
                <div
                  key={`${chunkIndex}-${lineIndex}`}
                  role="row"
                  className={classNames(
                    'version-diff-reviewer__diff-row',
                    `is-${type}`,
                    isActiveLine && 'is-active-line',
                  )}
                  onClick={() => {
                    const line = currentTargetLine ?? currentBaseLine;
                    if (line !== undefined) handleDiffLineClick(line);
                  }}
                >
                  <span className="version-diff-reviewer__diff-line-num" role="cell" aria-label={`基线行 ${currentBaseLine ?? ''}`}>
                    {currentBaseLine ?? ''}
                  </span>
                  <span className="version-diff-reviewer__diff-line-num" role="cell" aria-label={`目标行 ${currentTargetLine ?? ''}`}>
                    {currentTargetLine ?? ''}
                  </span>
                  <span className="version-diff-reviewer__diff-marker" role="cell" aria-hidden="true">
                    {type === 'equal' ? ' ' : type === 'insert' ? '+' : type === 'delete' ? '−' : type === 'replace' ? '±' : ''}
                  </span>
                  <span className="version-diff-reviewer__diff-content" role="cell">
                    {targetLine !== undefined ? targetLine : baseLine !== undefined ? baseLine : ''}
                  </span>
                </div>,
              );
            }

            return rows;
          })}
        </div>
      </div>
    );
  };

  const renderSideBySideDiff = () => {
    if (!baseVersion || !targetVersion) return null;
    if (diffChunks.length === 0) {
      return renderEmpty(
        <CheckCircle2 size={24} aria-hidden="true" />,
        '内容相同',
        '两个版本的文本完全一致。',
      );
    }

    let baseLineNumber = 1;
    let targetLineNumber = 1;

    return (
      <div className="version-diff-reviewer__diff-side-by-side" role="table" aria-label="并排差异">
        <div className="version-diff-reviewer__diff-side-by-side-header" role="row">
          <span role="columnheader">基线：{baseVersion.label}</span>
          <span role="columnheader">目标：{targetVersion.label}</span>
        </div>
        <div className="version-diff-reviewer__diff-side-by-side-body" role="rowgroup">
          {diffChunks.map((chunk, chunkIndex) => {
            const maxLines = Math.max(chunk.baseLines.length, chunk.targetLines.length);
            const rows: ReactNode[] = [];

            for (let lineIndex = 0; lineIndex < maxLines; lineIndex++) {
              const baseLine = chunk.baseLines[lineIndex];
              const targetLine = chunk.targetLines[lineIndex];
              const currentBaseLine = baseLine !== undefined ? baseLineNumber++ : undefined;
              const currentTargetLine = targetLine !== undefined ? targetLineNumber++ : undefined;
              const isActiveLine = commentLine === (currentTargetLine ?? currentBaseLine);

              rows.push(
                <div
                  key={`${chunkIndex}-${lineIndex}`}
                  className={classNames(
                    'version-diff-reviewer__diff-side-row',
                    `is-${chunk.type}`,
                    isActiveLine && 'is-active-line',
                  )}
                  role="row"
                  onClick={() => {
                    const line = currentTargetLine ?? currentBaseLine;
                    if (line !== undefined) handleDiffLineClick(line);
                  }}
                >
                  <div className="version-diff-reviewer__diff-side-cell version-diff-reviewer__diff-side-cell--base" role="cell">
                    <span className="version-diff-reviewer__diff-side-line-num">{currentBaseLine ?? ''}</span>
                    <span className="version-diff-reviewer__diff-side-content">{baseLine ?? ''}</span>
                  </div>
                  <div className="version-diff-reviewer__diff-side-cell version-diff-reviewer__diff-side-cell--target" role="cell">
                    <span className="version-diff-reviewer__diff-side-line-num">{currentTargetLine ?? ''}</span>
                    <span className="version-diff-reviewer__diff-side-content">{targetLine ?? ''}</span>
                  </div>
                </div>,
              );
            }

            return rows;
          })}
        </div>
      </div>
    );
  };

  const renderDiff = () => {
    if (loading) return renderLoading();
    if (!baseVersion || !targetVersion) {
      return renderEmpty(
        <GitCompare size={24} aria-hidden="true" />,
        '选择版本',
        '请从左侧列表选择基线和目标版本以开始对比。',
      );
    }
    if (baseVersion.id === targetVersion.id) {
      return renderEmpty(
        <GitCompare size={24} aria-hidden="true" />,
        '基线与目标相同',
        '请选择两个不同的版本进行对比。',
      );
    }
    return viewMode === 'sideBySide' ? renderSideBySideDiff() : renderInlineDiff();
  };

  const renderReviews = () => {
    if (reviews.length === 0 && !targetVersion) {
      return renderEmpty(
        <MessageSquareWarning size={24} aria-hidden="true" />,
        '暂无批注',
        '选择目标版本后即可添加审阅批注。',
      );
    }

    return (
      <div className="version-diff-reviewer__review-panel">
        <div className="version-diff-reviewer__review-form">
          <label htmlFor={`${instanceId}-review-comment`}>
            {commentLine !== undefined ? `在第 ${commentLine} 行添加批注` : '添加审阅批注'}
          </label>
          <textarea
            ref={commentInputRef}
            id={`${instanceId}-review-comment`}
            rows={3}
            value={commentDraft}
            onChange={(event) => setCommentDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) {
                event.preventDefault();
                handleAddComment();
              }
            }}
            placeholder="输入批注内容，按 Ctrl+Enter 提交…"
            disabled={!onAddReviewComment}
          />
          <div className="version-diff-reviewer__review-form-actions">
            {commentLine !== undefined && (
              <button
                type="button"
                className="version-diff-reviewer__review-form-clear"
                onClick={() => setCommentLine(undefined)}
              >
                清除行号
              </button>
            )}
            <button
              type="button"
              className="version-diff-reviewer__review-form-submit"
              onClick={handleAddComment}
              disabled={!commentDraft.trim() || !onAddReviewComment}
            >
              <Plus size={13} aria-hidden="true" />
              <span>提交批注</span>
            </button>
          </div>
        </div>

        {reviews.length === 0 ? (
          <div className="version-diff-reviewer__review-empty" role="status">
            暂无审阅批注
          </div>
        ) : (
          <div
            ref={reviewListRef}
            className="version-diff-reviewer__review-list"
            role="listbox"
            aria-label="审阅批注列表"
            onKeyDown={handleReviewListKeyDown}
          >
            {reviews.map((review) => (
              <div
                key={review.id}
                data-review-id={review.id}
                className={classNames(
                  'version-diff-reviewer__review-item',
                  activeReviewId === review.id && 'is-active',
                  review.resolved && 'is-resolved',
                )}
                role="option"
                aria-selected={activeReviewId === review.id}
                tabIndex={activeReviewId === review.id ? 0 : -1}
                onClick={() => setActiveReviewId(review.id)}
              >
                <div className="version-diff-reviewer__review-header">
                  <span className="version-diff-reviewer__review-author">
                    {review.author ?? '审阅者'}
                  </span>
                  {review.line !== undefined && (
                    <span className="version-diff-reviewer__review-line">第 {review.line} 行</span>
                  )}
                  {review.createdAt && (
                    <span className="version-diff-reviewer__review-date">{review.createdAt}</span>
                  )}
                </div>
                <p className="version-diff-reviewer__review-text">{review.text}</p>
                {onResolveReview && (
                  <button
                    type="button"
                    className={classNames(
                      'version-diff-reviewer__review-resolve',
                      review.resolved && 'is-resolved',
                    )}
                    onClick={(event) => {
                      event.stopPropagation();
                      handleResolveReview(review.id, !review.resolved);
                    }}
                    aria-pressed={review.resolved}
                    aria-label={review.resolved ? '标记为未解决' : '标记为已解决'}
                  >
                    <Check size={12} aria-hidden="true" />
                    <span>{review.resolved ? '已解决' : '解决'}</span>
                  </button>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    );
  };

  return (
    <div
      ref={rootRef}
      className={classNames('version-diff-reviewer', className)}
      data-responsive-band={resolvedBand}
      role="region"
      aria-label="版本差异审阅"
    >
      {renderError()}

      {/* ── Toolbar ── */}
      <div className="version-diff-reviewer__toolbar" role="toolbar" aria-label="差异审阅工具栏">
        <div className="version-diff-reviewer__toolbar-group" role="group" aria-label="版本选择">
          <div className="version-diff-reviewer__picker">
            <label htmlFor={`${instanceId}-base`} className="version-diff-reviewer__picker-label">
              <GitCompare size={12} aria-hidden="true" />
              <span>基线</span>
            </label>
            <div className="version-diff-reviewer__picker-control">
              <select
                id={`${instanceId}-base`}
                value={baseVersionId ?? ''}
                onChange={(event) => setBaseVersionId(event.target.value)}
                disabled={loading || versions.length === 0}
              >
                <option value="">选择版本…</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </div>
          </div>

          <div className="version-diff-reviewer__picker">
            <label htmlFor={`${instanceId}-target`} className="version-diff-reviewer__picker-label">
              <FileText size={12} aria-hidden="true" />
              <span>目标</span>
            </label>
            <div className="version-diff-reviewer__picker-control">
              <select
                id={`${instanceId}-target`}
                value={targetVersionId ?? ''}
                onChange={(event) => setTargetVersionId(event.target.value)}
                disabled={loading || versions.length === 0}
              >
                <option value="">选择版本…</option>
                {versions.map((v) => (
                  <option key={v.id} value={v.id}>
                    {v.label}
                  </option>
                ))}
              </select>
              <ChevronDown size={12} aria-hidden="true" />
            </div>
          </div>
        </div>

        <div className="version-diff-reviewer__toolbar-group" role="group" aria-label="视图模式">
          {(['inline', 'sideBySide'] as DiffViewMode[]).map((mode) => (
            <button
              key={mode}
              type="button"
              className={classNames(
                'version-diff-reviewer__toolbar-btn',
                viewMode === mode && 'is-active',
              )}
              onClick={() => setViewMode(mode)}
              aria-pressed={viewMode === mode}
              aria-label={`切换到${VIEW_MODE_LABELS[mode]}视图`}
              disabled={!baseVersion || !targetVersion || baseVersion.id === targetVersion.id}
            >
              {mode === 'sideBySide' ? (
                <Columns2 size={14} aria-hidden="true" />
              ) : (
                <ListFilter size={14} aria-hidden="true" />
              )}
              <span>{VIEW_MODE_LABELS[mode]}</span>
            </button>
          ))}
        </div>

        <ArtifactVersionReviewActions
          targetVersion={targetVersion}
          baseVersion={baseVersion}
          loading={loading}
          onApprove={onApprove}
          onReject={onReject}
          onRequestChanges={onRequestChanges}
        />
      </div>

      {/* ── Body ── */}
      <div className="version-diff-reviewer__body">
        <aside className="version-diff-reviewer__column version-diff-reviewer__column--versions" aria-label="版本列表">
          <div className="version-diff-reviewer__column-header">
            <History size={14} aria-hidden="true" />
            <span>版本</span>
            <span className="version-diff-reviewer__column-count">{versions.length}</span>
          </div>
          {renderVersionList()}
        </aside>

        <section
          ref={diffScrollRef}
          className="version-diff-reviewer__column version-diff-reviewer__column--diff"
          role="region"
          aria-label="差异对比"
          tabIndex={0}
          onKeyDown={handleDiffKeyDown}
        >
          {renderDiff()}
        </section>

        <aside className="version-diff-reviewer__column version-diff-reviewer__column--reviews" aria-label="审阅批注">
          <div className="version-diff-reviewer__column-header">
            <MessageSquareWarning size={14} aria-hidden="true" />
            <span>批注</span>
            <span className="version-diff-reviewer__column-count">{reviews.length}</span>
          </div>
          {renderReviews()}
        </aside>
      </div>

      {/* ── Screen-reader announcements ── */}
      <div
        ref={liveRegionRef}
        className="version-diff-reviewer__sr-only"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      />
    </div>
  );
}

export {
  GitCompare,
  Columns2,
  FileText,
  CheckCircle2,
  XCircle,
  MessageSquareWarning,
  Loader2,
  AlertCircle,
  RefreshCw,
  ChevronDown,
  Plus,
  Check,
  ListFilter,
  History,
};
