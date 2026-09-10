import { type ReactNode, useEffect } from 'react';
import { X } from 'lucide-react';
import './ui.css';

export interface SheetProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title?: ReactNode;
  children: ReactNode;
  footer?: ReactNode;
}

export function Sheet({ open, onOpenChange, title, children, footer }: SheetProps) {
  useEffect(() => {
    if (!open) return;
    const handleKeyDown = (e: KeyboardEvent) => {
      if (e.key === 'Escape') onOpenChange(false);
    };
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  }, [open, onOpenChange]);

  if (!open) return null;

  return (
    <>
      <div
        className="mui-sheet-overlay"
        onClick={() => onOpenChange(false)}
        role="presentation"
      />
      <div className="mui-sheet" role="dialog" aria-modal="true" aria-labelledby={title ? 'mui-sheet-title' : undefined}>
        {title && (
          <div className="mui-sheet__header">
            <h2 id="mui-sheet-title" className="mui-sheet__title">{title}</h2>
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
        <div className="mui-sheet__body">{children}</div>
        {footer && <div className="mui-sheet__footer">{footer}</div>}
      </div>
    </>
  );
}
