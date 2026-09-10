/**
 * GoalCardInline — renders an inline Goal card inside the Chat message stream.
 *
 * Shows the full lifecycle of a Goal:
 *   creating → planning → executing → completed / failed
 *
 * Reuses existing CSS classes (.progress-bar, .plan-step, .exec-step, .status-dot, etc.)
 * and the new .goal-card-inline* classes from App.css.
 */

import { useTranslation } from '../i18n';
import type { UIMode } from '../../engine/capabilities/DiagnosticMode';
import { presentExecutionError } from '../presentation/executionPresentation';
import { presentSafeMarkdownText } from '../presentation/SafeMarkdown';

// ─── Types (mirrors ChatPage GoalCardData) ────────────────────

export interface GoalStepStatus {
  stepId: string;
  stepName: string;
  status: 'pending' | 'running' | 'completed' | 'failed' | 'skipped' | 'unknown';
  output: string;
}

export interface GoalCardData {
  goalId: string;
  description: string;
  phase: 'creating' | 'planning' | 'plan_ready' | 'executing' | 'paused' | 'completed' | 'failed' | 'cancelled' | 'unknown';
  planName?: string;
  planDescription?: string;
  steps: Array<{ id: string; name: string; description: string }>;
  stepStatuses: Record<string, GoalStepStatus>;
  progress: { completed: number; total: number; currentStep: string };
  reasoning?: string;
  error?: string;
  /** Main process accepted a cooperative pause request; the current step still owns the boundary. */
  pauseRequested?: boolean;
  canRefine: boolean;
}

interface GoalCardInlineProps {
  data: GoalCardData;
  uiMode?: UIMode;
  registerStepElement?: (stepId: string, element: HTMLElement | null) => void;
  onPause?: () => void;
  onCancel?: () => void;
  onResume?: () => void;
  onRetry?: () => void;
  onOpenBoard?: () => void;
}

// ─── Status color map ────────────────────────────────────────

const STATUS_COLORS: Record<string, string> = {
  pending: 'var(--text-muted)',
  running: 'var(--status-running)',
  completed: 'var(--status-completed)',
  failed: 'var(--status-failed)',
  skipped: 'var(--text-muted)',
};

const STATUS_LABEL_KEYS: Record<string, string> = {
  pending: 'paused',
  running: 'executing',
  completed: 'completed',
  failed: 'failed',
  skipped: 'paused',
  unknown: 'paused',
};

const PHASE_CLASSES: Record<GoalCardData['phase'], string> = {
  creating: 'creating',
  planning: 'planning',
  plan_ready: 'plan-ready',
  executing: 'executing',
  paused: 'paused',
  completed: 'completed',
  failed: 'failed',
  cancelled: 'cancelled',
  unknown: 'unknown',
};

const STATUS_CLASSES: Record<GoalStepStatus['status'], string> = {
  pending: 'pending',
  running: 'running',
  completed: 'completed',
  failed: 'failed',
  skipped: 'skipped',
  unknown: 'pending',
};

/**
 * Production cards still show the real Workflow names supplied by the
 * engine.  Only labels that plainly expose runtime implementation terms are
 * replaced with their user-facing plan/step fallback; diagnostic mode keeps
 * the original text for troubleshooting.
 */
const INTERNAL_EXECUTION_COPY = /\b(?:agentloop|provider|mcp|runtime)\b/i;

export function isInternalExecutionCopy(value: string | undefined): boolean {
  return Boolean(value && INTERNAL_EXECUTION_COPY.test(value));
}

// ─── Component ────────────────────────────────────────────────

export default function GoalCardInline({
  data,
  uiMode = 'normal',
  registerStepElement,
  onPause,
  onCancel,
  onResume,
  onRetry,
  onOpenBoard,
}: GoalCardInlineProps) {
  const { t, locale } = useTranslation();
  const diagnosticMode = uiMode === 'diagnostic';

  const phaseLabel: Record<string, string> = {
    creating: t('chat.goalCreating'),
    planning: t('chat.goalPlanning'),
    plan_ready: t('chat.goalPlanning'),
    executing: t('chat.goalExecuting'),
    paused: t('goal.paused'),
    completed: t('chat.goalCompleted'),
    failed: t('chat.goalFailed'),
    cancelled: locale === 'zh' ? '已取消' : 'Cancelled',
    unknown: t('chat.goalUnavailable'),
  };
  const safeText = (value: string) => presentSafeMarkdownText(value, uiMode, locale);
  const displayPlanName = data.planName && (diagnosticMode || !isInternalExecutionCopy(data.planName))
    ? safeText(data.planName)
    : t('chat.researchPlan');
  const displayPlanDescription = data.planDescription
    && (diagnosticMode || !isInternalExecutionCopy(data.planDescription))
    ? safeText(data.planDescription)
    : '';
  const safeCompleted = Number.isFinite(data.progress.completed)
    ? Math.max(0, data.progress.completed)
    : 0;
  const safeTotal = Number.isFinite(data.progress.total)
    ? Math.max(0, data.progress.total)
    : 0;
  const progressPercent = safeTotal > 0
    ? Math.min(100, (Math.min(safeCompleted, safeTotal) / safeTotal) * 100)
    : 0;

  return (
    <section className="goal-card-inline" data-testid="goal-card-inline" aria-label={safeText(data.description)}>
      {/* Header */}
      <div className="goal-card-header">
        <span className="goal-card-title">{safeText(data.description)}</span>
        <span className={`goal-card-phase ${PHASE_CLASSES[data.phase]}`} role="status">{phaseLabel[data.phase]}</span>
      </div>

      {/* Creating / Planning spinner */}
      {(data.phase === 'creating' || data.phase === 'planning') && (
        <div className="goal-card-spinner">
          <div className="hydration-spinner" />
          <span>{data.phase === 'creating' ? t('chat.goalCreating') : t('chat.goalPlanning')}</span>
        </div>
      )}

      {data.pauseRequested && data.phase === 'executing' && (
        <div className="goal-card-pause-notice" data-testid="goal-pause-requested" role="status">
          {locale === 'zh'
            ? '暂停请求中：当前步骤跑完后即暂停，届时按钮区会出现「继续」。'
            : 'Pause requested: the run pauses after the current step; a Resume button will appear.'}
        </div>
      )}
      {data.phase === 'paused' && (
        <div className="goal-card-pause-notice" role="status">
          {locale === 'zh'
            ? '已暂停：点下方「继续」从当前步骤恢复执行。'
            : 'Paused: click Resume below to continue from the current step.'}
        </div>
      )}

      {/* This is a real Workflow timeline. Steps come from Goal/Workflow IPC and
          receive their status only through the goal live event stream. */}
      {(data.phase === 'executing' || data.phase === 'paused' || data.phase === 'completed' || data.phase === 'failed' || data.phase === 'cancelled') && data.steps.length > 0 && (
        <div className="goal-card-plan">
          <div className="goal-card-plan-name">
            {displayPlanName}
          </div>
          {displayPlanDescription && (
            <div className="goal-card-plan-desc">{displayPlanDescription}</div>
          )}

          {/* Progress bar */}
          {safeTotal > 0 && (
            <>
              <div className="progress-bar">
                <div
                  className="progress-fill"
                  style={{
                    background: data.phase === 'failed' ? 'var(--status-failed)' : 'var(--status-running)',
                    width: `${progressPercent}%`,
                  }}
                />
              </div>
              <div className="goal-card-progress-text">
                {Math.min(safeCompleted, safeTotal)} / {safeTotal}
                {diagnosticMode && data.progress.currentStep && ` — ${safeText(data.progress.currentStep)}`}
              </div>
            </>
          )}

          {/* Step list */}
          <ol className="goal-card-steps" data-testid="goal-execution-timeline" aria-label={t('chat.researchPlan')}>
            {data.steps.map((step, index) => {
              const status = data.stepStatuses[step.id]?.status ?? 'pending';
              const displayStepName = step.name && (diagnosticMode || !isInternalExecutionCopy(step.name))
                ? safeText(step.name)
                : t('chat.researchPlanStep', { index: index + 1 });
              const displayStepDescription = step.description
                && (diagnosticMode || !isInternalExecutionCopy(step.description))
                ? safeText(step.description)
                : '';
              return (
                <li
                  key={step.id}
                  ref={(element) => registerStepElement?.(step.id, element)}
                  className={`exec-step ${status === 'running' ? 'running' : ''}`}
                  aria-current={status === 'running' ? 'step' : undefined}
                >
                  <span className={`status-dot ${STATUS_CLASSES[status]}`} />
                  <span className="goal-card-step-copy">
                    <span className="exec-step-name">
                      {displayStepName}
                    </span>
                    {displayStepDescription && <span className="goal-card-step-description">{displayStepDescription}</span>}
                  </span>
                  <span
                    className="status-indicator"
                    style={{ fontSize: 11, color: STATUS_COLORS[status] ?? STATUS_COLORS['pending'] }}
                  >
                    {t(`goal.${STATUS_LABEL_KEYS[status] ?? 'paused'}`)}
                  </span>
                </li>
              );
            })}
          </ol>
        </div>
      )}

      {/* Technical planning rationale is available only in developer diagnostics. */}
      {diagnosticMode && data.reasoning && (
        <div className="goal-card-reasoning">{safeText(data.reasoning)}</div>
      )}

      {/* Raw execution errors are sanitized in normal mode. */}
      {data.error && (
        <div className="goal-card-error">
          {presentExecutionError(safeText(data.error), locale, uiMode)}
        </div>
      )}

      {/* Completed step output can contain internal execution details. */}
      {diagnosticMode && data.phase === 'completed' && (
        <div className="goal-card-results">
          {Object.values(data.stepStatuses)
            .filter((s) => s.output && s.status === 'completed')
            .map((s) => (
              <div key={s.stepId} className="goal-card-result-item">
                <div className="goal-card-result-title">{safeText(s.stepName)}</div>
                <div style={{ color: 'var(--text-secondary)', whiteSpace: 'pre-wrap', maxHeight: 120, overflow: 'auto' }}>
                  {safeText(s.output.length > 300 ? `${s.output.slice(0, 300)}...` : s.output)}
                </div>
              </div>
            ))}
        </div>
      )}

      {/* Action buttons */}
      <div className="goal-card-actions">
        {data.phase === 'executing' && onPause && (
          <button type="button" className="btn-sm btn-secondary" data-testid="goal-pause" disabled={data.pauseRequested} onClick={onPause}>{data.pauseRequested ? (locale === 'zh' ? '暂停请求中…' : 'Pausing…') : (locale === 'zh' ? '暂停' : 'Pause')}</button>
        )}
        {(data.phase === 'executing' || data.phase === 'plan_ready' || data.phase === 'paused') && onCancel && (
          <button type="button" className="btn-sm btn-secondary" onClick={onCancel}>{t('chat.goalCancel')}</button>
        )}
        {data.phase === 'paused' && onResume && (
          <button type="button" className="btn-sm btn-primary" data-testid="goal-resume" onClick={onResume}>{t('chat.goalResume')}</button>
        )}
        {data.phase === 'failed' && onRetry && (
          <button type="button" className="btn-sm btn-primary" onClick={onRetry}>{t('chat.goalRetry')}</button>
        )}
        {data.phase === 'failed' && onResume && (
          <button type="button" className="btn-sm btn-secondary" onClick={onResume}>{t('chat.goalResume')}</button>
        )}
        {data.goalId && onOpenBoard && (
          <button type="button" className="btn-sm btn-secondary" data-testid="goal-open-board" onClick={onOpenBoard}>{t('chat.goalOpenBoard')}</button>
        )}
      </div>
    </section>
  );
}
