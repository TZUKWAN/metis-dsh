import './ui.css';

export interface SeparatorProps {
  orientation?: 'horizontal' | 'vertical';
  className?: string;
}

export function Separator({ orientation = 'horizontal', className = '' }: SeparatorProps) {
  return (
    <hr
      className={`mui-separator mui-separator--${orientation} ${className}`}
      role="separator"
      aria-orientation={orientation}
    />
  );
}
