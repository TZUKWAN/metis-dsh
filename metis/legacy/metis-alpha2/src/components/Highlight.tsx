/**
 * Highlight — render text with case-insensitive query matches emphasized.
 */

import type { ReactNode } from 'react';

export interface HighlightProps {
  text: string;
  query: string;
}

export function Highlight({ text, query }: HighlightProps): ReactNode {
  const trimmed = query.trim();
  if (!trimmed) {
    return text;
  }

  const q = trimmed.toLowerCase();
  const parts: ReactNode[] = [];
  let remaining = text;

  while (remaining.length > 0) {
    const idx = remaining.toLowerCase().indexOf(q);
    if (idx === -1) {
      parts.push(remaining);
      break;
    }

    if (idx > 0) {
      parts.push(remaining.slice(0, idx));
    }

    const match = remaining.slice(idx, idx + trimmed.length);
    parts.push(
      <mark
        key={parts.length}
        style={{
          background: 'var(--search-highlight-bg)',
          borderRadius: 2,
          padding: '0 2px',
          color: 'inherit',
          fontWeight: 600,
        }}
      >
        {match}
      </mark>,
    );

    remaining = remaining.slice(idx + trimmed.length);
  }

  return <>{parts}</>;
}
