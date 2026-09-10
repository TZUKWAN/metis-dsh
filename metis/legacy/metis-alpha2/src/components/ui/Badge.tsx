import { type ReactNode } from 'react';
import './ui.css';

export interface BadgeProps {
  variant?: 'default' | 'primary' | 'success' | 'warning' | 'danger';
  children: ReactNode;
  className?: string;
}

export function Badge({ variant = 'default', children, className = '' }: BadgeProps) {
  return <span className={`mui-badge mui-badge--${variant} ${className}`}>{children}</span>;
}
