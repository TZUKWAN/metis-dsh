import { forwardRef, type InputHTMLAttributes } from 'react';
import './ui.css';

export interface SwitchProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Switch = forwardRef<HTMLInputElement, SwitchProps>(
  ({ className = '', ...props }, ref) => (
    <input ref={ref} type="checkbox" className={`mui-switch ${className}`} role="switch" {...props} />
  ),
);

Switch.displayName = 'Switch';
