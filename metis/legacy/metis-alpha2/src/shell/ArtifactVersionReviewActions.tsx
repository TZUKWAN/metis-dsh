/**
 * ArtifactVersionReviewActions — standalone approve / reject / request-changes
 * actions for artifact version review.
 *
 * Features:
 *   - Props-driven callbacks for approve, reject, and request-changes.
 *   - Disabled when no target version is selected, while loading, or when a
 *     callback is not provided (fail-closed: missing handler = no action).
 *   - Per-action loading spinner with async callback support.
 *   - Keyboard accessible (native buttons, focus rings).
 *   - RTL-aware via CSS logical properties.
 *   - Supports forced-colors mode and prefers-reduced-motion.
 *   - Narrow-screen adaptation via data-responsive-band.
 *
 * All backend-dependent work is delegated through props; this component never
 * invents results.
 */

import { useCallback, useState, type KeyboardEvent } from 'react';
import { CheckCircle2, XCircle, MessageSquareWarning, Loader2 } from 'lucide-react';
import './ArtifactVersionReviewActions.css';
import type { VersionItem, VersionStatus } from './VersionDiffReviewer';

export interface ArtifactVersionReviewActionsProps {
  /** The version being reviewed (actions apply to the target). */
  targetVersion?: VersionItem | null;
  /** Optional base version, shown for context only. */
  baseVersion?: VersionItem | null;
  /** When true, all action buttons are disabled and show a spinner on the active one. */
  loading?: boolean;
  /** Called when the user approves the target version. */
  onApprove?: () => void | Promise<void>;
  /** Called when the user rejects the target version. */
  onReject?: () => void | Promise<void>;
  /** Called when the user requests changes to the target version. */
  onRequestChanges?: () => void | Promise<void>;
  /** Additional class for the root element. */
  className?: string;
}

type ReviewAction = 'approve' | 'reject' | 'requestChanges';

const ACTION_CONFIG: Record<
  ReviewAction,
  {
    label: string;
    icon: typeof CheckCircle2;
    status: VersionStatus;
    classSuffix: string;
  }
> = {
  approve: {
    label: '批准',
    icon: CheckCircle2,
    status: 'approved',
    classSuffix: 'approve',
  },
  reject: {
    label: '拒绝',
    icon: XCircle,
    status: 'rejected',
    classSuffix: 'reject',
  },
  requestChanges: {
    label: '要求修改',
    icon: MessageSquareWarning,
    status: 'changes_requested',
    classSuffix: 'request',
  },
};

export default function ArtifactVersionReviewActions({
  targetVersion,
  baseVersion,
  loading = false,
  onApprove,
  onReject,
  onRequestChanges,
  className = '',
}: ArtifactVersionReviewActionsProps) {
  const [activeAction, setActiveAction] = useState<ReviewAction | null>(null);

  const runAction = useCallback(
    async (action: ReviewAction, handler?: () => void | Promise<void>) => {
      if (!handler || loading || !targetVersion) return;
      setActiveAction(action);
      try {
        await handler();
      } finally {
        setActiveAction(null);
      }
    },
    [loading, targetVersion],
  );

  const handleApprove = useCallback(
    () => runAction('approve', onApprove),
    [onApprove, runAction],
  );
  const handleReject = useCallback(
    () => runAction('reject', onReject),
    [onReject, runAction],
  );
  const handleRequestChanges = useCallback(
    () => runAction('requestChanges', onRequestChanges),
    [onRequestChanges, runAction],
  );

  const handlers: Record<ReviewAction, () => void> = {
    approve: handleApprove,
    reject: handleReject,
    requestChanges: handleRequestChanges,
  };

  const handleKeyDown = useCallback(
    (event: KeyboardEvent<HTMLDivElement>) => {
      if (event.key === 'ArrowRight' || event.key === 'ArrowLeft') {
        const buttons = Array.from(
          event.currentTarget.querySelectorAll<HTMLButtonElement>('button[type="button"]'),
        ).filter((button) => !button.disabled);
        if (buttons.length === 0) return;
        const index = buttons.indexOf(document.activeElement as HTMLButtonElement);
        const delta = event.key === 'ArrowRight' ? 1 : -1;
        const next = buttons[(index + delta + buttons.length) % buttons.length];
        if (next) {
          event.preventDefault();
          next.focus();
        }
      }
    },
    [],
  );

  const contextLabel = targetVersion
    ? baseVersion && baseVersion.id !== targetVersion.id
      ? `审阅目标：${targetVersion.label}（基线：${baseVersion.label}）`
      : `审阅目标：${targetVersion.label}`
    : '未选择审阅目标';

  const disabled = !targetVersion || loading;

  return (
    <div
      className={`artifact-version-review-actions ${className}`.trim()}
      role="toolbar"
      aria-label="版本审阅结论"
      aria-disabled={disabled}
      onKeyDown={handleKeyDown}
    >
      <span className="artifact-version-review-actions__context" aria-hidden="true">
        {contextLabel}
      </span>
      <div className="artifact-version-review-actions__buttons" role="group" aria-label="审阅操作">
        {(Object.keys(ACTION_CONFIG) as ReviewAction[]).map((action) => {
          const config = ACTION_CONFIG[action];
          const handler = handlers[action];
          const isMissing =
            (action === 'approve' && !onApprove) ||
            (action === 'reject' && !onReject) ||
            (action === 'requestChanges' && !onRequestChanges);
          const isActive = activeAction === action;
          const isDisabled = disabled || isMissing || isActive;

          return (
            <button
              key={action}
              type="button"
              className={`artifact-version-review-actions__btn artifact-version-review-actions__btn--${config.classSuffix}`}
              onClick={handler}
              disabled={isDisabled}
              aria-busy={isActive}
              aria-label={`${config.label}${targetVersion ? ` ${targetVersion.label}` : ''}`}
              title={isMissing ? '该操作尚未接入后端' : config.label}
            >
              {isActive ? (
                <Loader2 size={14} className="artifact-version-review-actions__spinner" aria-hidden="true" />
              ) : (
                <config.icon size={14} aria-hidden="true" />
              )}
              <span>{config.label}</span>
            </button>
          );
        })}
      </div>
    </div>
  );
}

export type { VersionItem, VersionStatus };
