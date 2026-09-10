/**
 * 轻量错误/状态反馈组件（任务4 第四节）。
 *
 * 普通用户看到：发生什么 / 影响什么 / 下一步。
 * 开发者诊断：error code（弱化展示，不默认展示 stack）。
 * 视觉纪律：Typography / spacing / divider，不做巨大红卡、不做全屏 spinner。
 */
import { useEffect, useRef, useState, type ReactNode } from 'react';
import { AlertCircle, Archive, Inbox, LoaderCircle, RotateCw } from 'lucide-react';
import './async.css';

export interface InlineErrorProps {
  /** 发生了什么 + 影响什么。 */
  title: string;
  /** 下一步建议（可选，默认由 retry 按钮承载）。 */
  hint?: string;
  /** 开发者诊断错误码；普通模式下弱化为一行小字。 */
  code?: string;
  onRetry?: () => void;
  /** 重试在途时按钮转 pending。 */
  retrying?: boolean;
  /** 紧凑模式（面板/侧栏内）。 */
  compact?: boolean;
}

/** 行内错误：error 状态的标准呈现（首次加载失败、操作失败）。 */
export function InlineError({ title, hint, code, onRetry, retrying, compact }: InlineErrorProps) {
  return (
    <div className={`async-inline-error${compact ? ' async-inline-error--compact' : ''}`} role="alert">
      <AlertCircle size={compact ? 14 : 16} aria-hidden="true" />
      <div className="async-inline-error__body">
        <p className="async-inline-error__title">{title}</p>
        {hint && <p className="async-inline-error__hint">{hint}</p>}
        {code && <p className="async-inline-error__code">错误码：{code}</p>}
      </div>
      {onRetry && (
        <button
          type="button"
          className="async-retry-btn"
          onClick={onRetry}
          disabled={retrying}
          data-testid="async-retry"
        >
          {retrying ? <LoaderCircle size={13} className="async-spin" aria-hidden="true" /> : <RotateCw size={13} aria-hidden="true" />}
          {retrying ? '重试中…' : '重试'}
        </button>
      )}
    </div>
  );
}

export interface StaleDataNoticeProps {
  /** 刷新失败的补充说明（可选）。默认文案即任务书要求的提示。 */
  message?: string;
  code?: string;
  onRetry?: () => void;
  retrying?: boolean;
}

/** 陈旧数据提示：刷新失败但保留旧数据时，必须明确告知"这不是最新"。 */
export function StaleDataNotice({ message, code, onRetry, retrying }: StaleDataNoticeProps) {
  return (
    <div className="async-stale-notice" role="status" data-testid="async-stale-notice">
      <Archive size={13} aria-hidden="true" />
      <span className="async-stale-notice__text">{message ?? '当前显示上次成功加载的数据'}</span>
      {code && <span className="async-stale-notice__code">{code}</span>}
      {onRetry && (
        <button type="button" className="async-retry-btn" onClick={onRetry} disabled={retrying} data-testid="async-stale-retry">
          {retrying ? <LoaderCircle size={12} className="async-spin" aria-hidden="true" /> : <RotateCw size={12} aria-hidden="true" />}
          {retrying ? '重试中…' : '重试'}
        </button>
      )}
    </div>
  );
}

export interface EmptyStateProps {
  /** 这个页面是干什么的。 */
  title: string;
  /** 一句话解释用途。 */
  description?: string;
  /** 第一动作（新建/导入/去设置…）。 */
  action?: ReactNode;
  icon?: ReactNode;
  compact?: boolean;
  testId?: string;
}

/** 空状态：首次进入告诉用户用途 + 第一动作，避免空白页或孤立"0"。 */
export function EmptyState({ title, description, action, icon, compact, testId }: EmptyStateProps) {
  return (
    <div className={`async-empty${compact ? ' async-empty--compact' : ''}`} data-testid={testId ?? 'async-empty'}>
      {icon !== undefined ? <span className="async-empty__icon" aria-hidden="true">{icon}</span> : <Inbox size={compact ? 18 : 24} className="async-empty__icon" aria-hidden="true" />}
      <p className="async-empty__title">{title}</p>
      {description && <p className="async-empty__description">{description}</p>}
      {action && <div className="async-empty__action">{action}</div>}
    </div>
  );
}

export interface OperationNoticeState {
  kind: 'success' | 'error' | 'info';
  text: string;
  /** 诊断码，弱化展示。 */
  code?: string;
}

export interface OperationNoticeProps {
  notice: OperationNoticeState | null;
  /** 自动清除毫秒数；error 默认不自动消失（需用户看到），success 默认 6s。 */
  autoClearMs?: number;
  onClear: () => void;
  testId?: string;
}

/**
 * 操作结果通知（局部状态，不用全局 toast 代替）。
 * 成功/失败分 kind 呈现；失败可携带诊断码。
 */
export function OperationNotice({ notice, autoClearMs, onClear, testId }: OperationNoticeProps) {
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => {
    if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; }
    if (!notice) return;
    const fallback = notice.kind === 'error' ? 0 : 6000;
    const ms = autoClearMs ?? fallback;
    if (ms > 0) {
      timerRef.current = setTimeout(onClear, ms);
    }
    return () => { if (timerRef.current) { clearTimeout(timerRef.current); timerRef.current = null; } };
  }, [notice, autoClearMs, onClear]);

  if (!notice) return null;
  return (
    <p
      className={`async-operation-notice async-operation-notice--${notice.kind}`}
      role={notice.kind === 'error' ? 'alert' : 'status'}
      data-testid={testId ?? 'async-operation-notice'}
    >
      <span className="async-operation-notice__text">{notice.text}</span>
      {notice.code && <span className="async-operation-notice__code">{notice.code}</span>}
    </p>
  );
}

/** 局部加载：安静的一行 spinner + 文案，不做全屏夸张 spinner。 */
export function QuietLoading({ label = '正在加载…', compact }: { label?: string; compact?: boolean }) {
  return (
    <p className={`async-quiet-loading${compact ? ' async-quiet-loading--compact' : ''}`} role="status" data-testid="async-loading">
      <LoaderCircle size={compact ? 13 : 15} className="async-spin" aria-hidden="true" />
      {label}
    </p>
  );
}

/**
 * ··· 行内操作菜单（任务4 第六节）：归档/删除等低频操作收纳，
 * 不长期占用行内横向空间。
 */
export interface RowActionsMenuItem {
  id: string;
  label: string;
  onSelect: () => void;
  /** 危险项标红。 */
  danger?: boolean;
  disabled?: boolean;
}

export function RowActionsMenu({ items, label = '更多操作', testId }: { items: RowActionsMenuItem[]; label?: string; testId?: string }) {
  const [open, setOpen] = useState(false);
  const rootRef = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!rootRef.current?.contains(event.target as Node)) setOpen(false);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === 'Escape') {
        event.stopPropagation();
        setOpen(false);
      }
    };
    window.addEventListener('pointerdown', onPointerDown);
    window.addEventListener('keydown', onKeyDown);
    return () => {
      window.removeEventListener('pointerdown', onPointerDown);
      window.removeEventListener('keydown', onKeyDown);
    };
  }, [open]);

  return (
    <div className="async-row-menu" ref={rootRef}>
      <button
        type="button"
        className="async-row-menu__trigger"
        aria-label={label}
        aria-haspopup="menu"
        aria-expanded={open}
        title={label}
        data-testid={testId ?? 'async-row-menu-trigger'}
        onClick={() => setOpen((value) => !value)}
      >
        ···
      </button>
      {open && (
        <div className="async-row-menu__list" role="menu" data-testid={testId ? `${testId}-list` : 'async-row-menu-list'}>
          {items.map((item) => (
            <button
              key={item.id}
              type="button"
              role="menuitem"
              className={`async-row-menu__item${item.danger ? ' async-row-menu__item--danger' : ''}`}
              disabled={item.disabled}
              onClick={() => { setOpen(false); item.onSelect(); }}
            >
              {item.label}
            </button>
          ))}
        </div>
      )}
    </div>
  );
}
