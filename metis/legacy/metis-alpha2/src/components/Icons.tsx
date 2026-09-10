// Shared icons — prefer Lucide, fall back to custom SVG only where no equivalent exists.

import type { ComponentType, CSSProperties } from 'react';
import {
  Check,
  X,
  TriangleAlert,
  Terminal,
  Paperclip,
  Tag,
  Clock,
  Search,
  Package,
  Play,
  Settings,
  FlaskConical,
  RefreshCw,
  Sparkles,
  Rocket,
  Brain,
  Columns2,
} from 'lucide-react';

interface IconProps {
  size?: number;
  className?: string;
  color?: string;
}

const wrap = (Icon: ComponentType<{ size?: number; className?: string; color?: string; strokeWidth?: number; style?: CSSProperties }>) =>
  ({ size = 16, className, color }: IconProps) => (
    <Icon size={size} className={className} color={color} strokeWidth={1.5} style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }} />
  );

export const CheckIcon = wrap(Check);
export const CrossIcon = wrap(X);
export const WarningIcon = wrap(TriangleAlert);
export const TerminalIcon = wrap(Terminal);
export const PaperclipIcon = wrap(Paperclip);
export const TagIcon = wrap(Tag);
export const ClockIcon = wrap(Clock);
export const SearchIcon = wrap(Search);
export const PackageIcon = wrap(Package);
export const PlayIcon = wrap(Play);
export const GearIcon = wrap(Settings);
export const FlaskIcon = wrap(FlaskConical);
export const RefreshIcon = wrap(RefreshCw);
export const SparklesIcon = wrap(Sparkles);
export const RocketIcon = wrap(Rocket);
export const BrainIcon = wrap(Brain);
/** O15: 多模型对比——左右并排的两个面板。 */
export const CompareIcon = wrap(Columns2);

// File-type icons rendered as simple colored squares with a label letter.
export function FileTypeIcon({ type, size = 24 }: { type: string; size?: number }) {
  const labels: Record<string, string> = {
    pdf: 'PDF',
    docx: 'DOC',
    xlsx: 'XLS',
    pptx: 'PPT',
    md: 'MD',
    latex: 'TEX',
    other: 'FILE',
  };
  const label = labels[type] ?? type.toUpperCase();
  return (
    <svg width={size} height={size} viewBox="0 0 24 24" style={{ display: 'inline-block', verticalAlign: 'middle', flexShrink: 0 }}>
      <rect x="3" y="3" width="18" height="18" rx="3" fill="var(--primary)" opacity="0.12" />
      <rect x="3" y="3" width="18" height="18" rx="3" stroke="var(--primary)" strokeWidth="1.5" fill="none" />
      <text x="12" y="16" textAnchor="middle" fontSize="7" fontWeight="600" fill="var(--primary)">{label}</text>
    </svg>
  );
}
