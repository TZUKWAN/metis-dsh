import './ui.css';

export interface SkeletonProps {
  width?: string | number;
  height?: string | number;
  className?: string;
}

export function Skeleton({ width = '100%', height = 16, className = '' }: SkeletonProps) {
  const style = { width: typeof width === 'number' ? `${width}px` : width, height: typeof height === 'number' ? `${height}px` : height };
  return <span className={`mui-skeleton ${className}`} style={style} aria-hidden="true" />;
}
