import { forwardRef, type InputHTMLAttributes } from 'react';
import './ui.css';

export interface RadioProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Radio = forwardRef<HTMLInputElement, RadioProps>(
  ({ className = '', ...props }, ref) => (
    <input ref={ref} type="radio" className={`mui-radio ${className}`} {...props} />
  ),
);

Radio.displayName = 'Radio';
