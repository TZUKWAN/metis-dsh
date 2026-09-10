/**
 * SearchInput — reusable search field with / shortcut focus and a clear button.
 */

import type { CSSProperties } from 'react';
import { X } from 'lucide-react';
import { Input } from './ui';
import { useSearchFocus } from '../hooks/useSearchFocus';

interface SearchInputProps {
  value: string;
  onChange: (value: string) => void;
  placeholder: string;
  className?: string;
  style?: CSSProperties;
}

export default function SearchInput({ value, onChange, placeholder, className, style }: SearchInputProps) {
  const inputRef = useSearchFocus<HTMLInputElement>();

  function handleClear() {
    onChange('');
    inputRef.current?.focus();
  }

  return (
    <div style={{ position: 'relative', display: 'flex', flex: '1 1 auto', ...style }}>
      <Input
        ref={inputRef}
        type="text"
        className={className}
        placeholder={placeholder}
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={{ width: '100%', paddingRight: 28, minWidth: 0 }}
      />
      {value && (
        <button
          type="button"
          onClick={handleClear}
          aria-label="Clear search"
          style={{
            position: 'absolute',
            right: 6,
            top: '50%',
            transform: 'translateY(-50%)',
            background: 'transparent',
            border: 'none',
            cursor: 'pointer',
            fontSize: 14,
            color: 'var(--text-muted)',
            lineHeight: 1,
            padding: 2,
            borderRadius: 'var(--radius-sm)',
          }}
        >
          <X size={14} />
        </button>
      )}
    </div>
  );
}
