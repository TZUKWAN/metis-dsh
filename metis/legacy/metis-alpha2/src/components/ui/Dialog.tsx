import { type ReactNode, useEffect, useRef } from 'react';
import { X } from 'lucide-react';
import './ui.css';

export interface DialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
  size?: 'sm' | 'default' | 'lg';
}

const FOCUSABLE_SELECTOR = 'a[href], button:not([disabled]), textarea:not([disabled]), input:not([disabled]), select:not([disabled]), [tabindex]:not([tabindex="-1"])';

export function Dialog({ open, onOpenChange, title, children, footer, size = 'default' }: DialogProps) {
  const ref = useRef<HTMLDivElement>(null);
  // 打开前的焦点元素：关闭时恢复（任务4 第十二节：Modal 关闭恢复 focus）。
  const previouslyFocusedRef = useRef<HTMLElement | null>(null);

  useEffect(() => {
    if (!open) return;
    previouslyFocusedRef.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;

    // 焦点移入对话框：优先第一个可聚焦控件，否则对话框本身。
    const focusFirst = () => {
      const dialogEl = ref.current;
      if (!dialogEl) return;
      const first = dialogEl.querySelector<HTMLElement>(FOCUSABLE_SELECTOR);
      (first ?? dialogEl).focus();
    };
    // 内容可能随挂载异步渲染（表单选项等），先试一次再等一帧兜底。
    focusFirst();
    const raf = requestAnimationFrame(focusFirst);

    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.stopPropagation();
        onOpenChange(false);
        return;
      }
      // 轻量焦点圈：Tab 循环限制在对话框内，避免焦点漂移到被遮罩的底层页面。
      if (e.key === 'Tab') {
        const dialogEl = ref.current;
        if (!dialogEl) return;
        const focusable = Array.from(dialogEl.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR))
          .filter((el) => el.offsetParent !== null || el === document.activeElement);
        if (focusable.length === 0) {
          e.preventDefault();
          dialogEl.focus();
          return;
        }
        const first = focusable[0]!;
        const last = focusable[focusable.length - 1]!;
        const current = document.activeElement;
        if (e.shiftKey) {
          if (current === first || !dialogEl.contains(current)) {
            e.preventDefault();
            last.focus();
          }
        } else if (current === last || !dialogEl.contains(current)) {
          e.preventDefault();
          first.focus();
        }
      }
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => {
      window.removeEventListener('keydown', handleKeyDown);
      cancelAnimationFrame(raf);
      // 恢复焦点到打开者；其已被卸载时退而求其次让浏览器自行处理。
      const previous = previouslyFocusedRef.current;
      if (previous && previous.isConnected) previous.focus();
    };
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <div
      className="mui-dialog-overlay modal-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onOpenChange(false); }}
      role="presentation"
    >
      <div
        ref={ref}
        className={`mui-dialog mui-dialog--${size}`}
        role="dialog"
        aria-modal="true"
        aria-labelledby={title ? 'mui-dialog-title' : undefined}
        tabIndex={-1}
      >
        {title && (
          <div className="mui-dialog__header">
            <h2 id="mui-dialog-title" className="mui-dialog__title">{title}</h2>
            <button
              type="button"
              className="mui-dialog__close"
              onClick={() => onOpenChange(false)}
              aria-label="Close"
            >
              <X size={16} />
            </button>
          </div>
        )}
        <div className="mui-dialog__body">{children}</div>
        {footer && <div className="mui-dialog__footer">{footer}</div>}
      </div>
    </div>
  );
}
