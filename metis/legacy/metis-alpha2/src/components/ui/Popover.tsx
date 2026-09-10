import { useState, type ReactNode, useRef, useEffect } from 'react';
import './ui.css';

export interface PopoverProps {
  trigger: ReactNode;
  children: ReactNode;
  align?: 'left' | 'right';
  side?: 'bottom' | 'top';
  open?: boolean;
  onOpenChange?: (open: boolean) => void;
}

export function Popover({ trigger, children, align = 'left', side = 'bottom', open: controlledOpen, onOpenChange }: PopoverProps) {
  const [internalOpen, setInternalOpen] = useState(false);
  const isControlled = controlledOpen !== undefined;
  const open = isControlled ? controlledOpen : internalOpen;
  const setOpen = (next: boolean) => {
    if (!isControlled) setInternalOpen(next);
    onOpenChange?.(next);
  };
  const ref = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const handleClickOutside = (e: MouseEvent) => {
      if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
    };
    window.addEventListener('mousedown', handleClickOutside);
    return () => window.removeEventListener('mousedown', handleClickOutside);
  }, [open]);

  const position = `${side}-${align}`;

  return (
    <div ref={ref} className="mui-popover">
      <div onClick={() => setOpen(!open)}>{trigger}</div>
      {open && <div className={`mui-popover__content mui-popover__content--${position}`}>{children}</div>}
    </div>
  );
}
