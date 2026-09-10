import { forwardRef, type ButtonHTMLAttributes, type ReactNode } from 'react';
import './ui.css';

export interface ButtonProps extends ButtonHTMLAttributes<HTMLButtonElement> {
  variant?: 'primary' | 'secondary' | 'ghost' | 'danger' | 'icon';
  size?: 'sm' | 'default' | 'lg';
  children: ReactNode;
}

export const Button = forwardRef<HTMLButtonElement, ButtonProps>(
  ({ variant = 'secondary', size = 'default', className = '', children, ...props }, ref) => {
    const isIcon = variant === 'icon';
    const effectiveVariant = isIcon ? 'ghost' : variant;
    const effectiveSize = isIcon ? 'icon' : size;
    const classes = [
      'mui-button',
      `mui-button--${effectiveVariant}`,
      `mui-button--${effectiveSize}`,
      className,
    ].join(' ');
    return (
      <button ref={ref} className={classes} {...props}>
        {children}
      </button>
    );
  },
);

Button.displayName = 'Button';
