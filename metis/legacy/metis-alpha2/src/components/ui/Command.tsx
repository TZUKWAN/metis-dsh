import { useState, useMemo, type ReactNode } from 'react';
import { Search } from 'lucide-react';
import './ui.css';

export interface CommandItem {
  id: string;
  label: ReactNode;
  onExecute: () => void;
  group?: string;
}

export interface CommandProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  placeholder?: string;
  items: CommandItem[];
}

export function Command({ open, onOpenChange, placeholder = 'Search...', items }: CommandProps) {
  const [query, setQuery] = useState('');

  const filtered = useMemo(() => {
    const q = query.trim().toLowerCase();
    if (!q) return items;
    return items.filter((item) => String(item.label).toLowerCase().includes(q));
  }, [query, items]);

  const groups = useMemo(() => {
    const map = new Map<string, CommandItem[]>();
    for (const item of filtered) {
      const group = item.group || 'Actions';
      if (!map.has(group)) map.set(group, []);
      map.get(group)!.push(item);
    }
    return [...map.entries()];
  }, [filtered]);

  if (!open) return null;

  return (
    <div
      className="mui-dialog-overlay"
      onClick={(e) => { if (e.target === e.currentTarget) onOpenChange(false); }}
      role="presentation"
    >
      <div className="mui-command" style={{ width: 560, maxWidth: '90vw' }} role="dialog" aria-modal="true">
        <div style={{ position: 'relative' }}>
          <Search size={16} style={{ position: 'absolute', left: 14, top: '50%', transform: 'translateY(-50%)', color: 'var(--text-muted)' }} />
          <input
            className="mui-command__input"
            style={{ paddingLeft: 38 }}
            placeholder={placeholder}
            value={query}
            onChange={(e) => setQuery(e.target.value)}
            autoFocus
          />
        </div>
        <div className="mui-command__list">
          {groups.map(([group, groupItems]) => (
            <div key={group}>
              <div className="mui-command__group-label">{group}</div>
              {groupItems.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  className="mui-command__item"
                  onClick={() => { item.onExecute(); onOpenChange(false); setQuery(''); }}
                >
                  {item.label}
                </button>
              ))}
            </div>
          ))}
          {groups.length === 0 && (
            <div className="mui-command__item" style={{ color: 'var(--text-muted)', cursor: 'default' }}>
              No results found.
            </div>
          )}
        </div>
      </div>
    </div>
  );
}
