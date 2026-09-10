import { forwardRef, type InputHTMLAttributes } from 'react';
import './ui.css';

export interface InputProps extends InputHTMLAttributes<HTMLInputElement> {}

export const Input = forwardRef<HTMLInputElement, InputProps>(
  ({ className = '', ...props }, ref) => (
    <input ref={ref} className={`mui-input ${className}`} {...props} />
  ),
);

Input.displayName = 'Input';
