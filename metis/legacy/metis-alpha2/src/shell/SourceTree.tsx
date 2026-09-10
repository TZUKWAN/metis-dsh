/**
 * SourceTree — left-column unified project + materials tree (METIS-502).
 *
 * Presents project, sources, notes, and artifacts in ONE tree (METIS-103: papers +
 * collections + tags + notes all merge into the library/project tree). Supports:
 *   - search/filter (client-side, debounced)
 *   - status indicators (read/unread, review status)
 *   - context menu (open / rename / delete / link-to)
 *   - virtual scrolling for large projects (METIS-502: 1/100/5000 nodes performant)
 *
 * Virtualization: only renders nodes within the viewport window. For 5000 nodes this keeps
 * the DOM at ~50 rows instead of 5000, so scrolling stays smooth.
 */

import { useState, useMemo, useRef, useEffect, useCallback, type ReactNode } from 'react';

export type SourceNodeKind = 'project' | 'source' | 'note' | 'artifact';

export interface SourceNode {
  id: string;
  kind: SourceNodeKind;
  label: string;
  status?: 'unread' | 'reading' | 'read' | 'draft' | 'verified' | 'stale';
  parentId: string | null;
  matchedBySearch?: boolean;
}

export interface SourceTreeProps {
  nodes: SourceNode[];
  selectedId?: string | null;
  onSelect?: (id: string) => void;
  /** Row height in px (for virtual scroll math). */
  rowHeight?: number;
  /** Max height of the tree viewport (px). */
  maxHeight?: number;
  /** Render a custom context-menu action row. */
  renderContextMenu?: (node: SourceNode) => ReactNode;
}

const STATUS_LABELS: Record<NonNullable<SourceNode['status']>, string> = {
  unread: '未读', reading: '阅读中', read: '已读',
  draft: '草稿', verified: '已核验', stale: '过期',
};

export default function SourceTree({
  nodes,
  selectedId,
  onSelect,
  rowHeight = 28,
  maxHeight = 600,
  renderContextMenu,
}: SourceTreeProps) {
  const [query, setQuery] = useState('');
  const [expanded, setExpanded] = useState<Set<string>>(new Set(nodes.filter((n) => n.kind === 'project').map((n) => n.id)));
  const [menuFor, setMenuFor] = useState<string | null>(null);
  const [scrollTop, setScrollTop] = useState(0);
  const [focusedId, setFocusedId] = useState<string | null>(selectedId ?? nodes[0]?.id ?? null);
  const viewportRef = useRef<HTMLDivElement>(null);
  const rowRefs = useRef(new Map<string, HTMLDivElement>());

  // Filter + flatten into visible ordered rows (respecting expand state).
  const visibleNodes = useMemo(() => {
    const q = query.trim().toLowerCase();
    const matches = new Set<string>();
    if (q) {
      for (const n of nodes) {
        if (n.label.toLowerCase().includes(q)) {
          matches.add(n.id);
          // also ensure ancestors stay visible
          let p = n.parentId;
          while (p) { matches.add(p); p = nodes.find((x) => x.id === p)?.parentId ?? null; }
        }
      }
    }
    const out: SourceNode[] = [];
    const walk = (parentId: string | null, depth: number) => {
      for (const n of nodes) {
        if (n.parentId !== parentId) continue;
        if (q && !matches.has(n.id)) continue;
        out.push({ ...n, matchedBySearch: matches.has(n.id) && !!q });
        const hasChildren = nodes.some((c) => c.parentId === n.id);
        if (hasChildren && expanded.has(n.id)) walk(n.id, depth + 1);
        else if (hasChildren && q) walk(n.id, depth + 1); // search forces expand
      }
    };
    walk(null, 0);
    return out;
  }, [nodes, query, expanded]);

  // Virtual scroll windowing.
  const startIndex = Math.max(0, Math.floor(scrollTop / rowHeight) - 5);
  const endIndex = Math.min(visibleNodes.length, Math.ceil((scrollTop + maxHeight) / rowHeight) + 5);
  const visibleSlice = visibleNodes.slice(startIndex, endIndex);

  const onScroll = useCallback((e: React.UIEvent<HTMLDivElement>) => {
    setScrollTop(e.currentTarget.scrollTop);
  }, []);

  const toggleExpand = useCallback((id: string) => {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id); else next.add(id);
      return next;
    });
  }, []);

  const focusVisibleNode = useCallback((nodeId: string) => {
    const index = visibleNodes.findIndex((node) => node.id === nodeId);
    if (index < 0) return;
    setFocusedId(nodeId);
    const viewport = viewportRef.current;
    if (viewport) {
      const top = index * rowHeight;
      const bottom = top + rowHeight;
      if (top < viewport.scrollTop) viewport.scrollTop = top;
      else if (bottom > viewport.scrollTop + viewport.clientHeight) {
        viewport.scrollTop = bottom - viewport.clientHeight;
      }
    }
    requestAnimationFrame(() => rowRefs.current.get(nodeId)?.focus());
  }, [rowHeight, visibleNodes]);

  const handleTreeItemKeyDown = useCallback((event: React.KeyboardEvent<HTMLDivElement>, node: SourceNode) => {
    const index = visibleNodes.findIndex((item) => item.id === node.id);
    if (index < 0) return;
    const hasChildren = nodes.some((child) => child.parentId === node.id);
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      const next = visibleNodes[Math.min(visibleNodes.length - 1, index + 1)];
      if (next) focusVisibleNode(next.id);
      return;
    }
    if (event.key === 'ArrowUp') {
      event.preventDefault();
      const previous = visibleNodes[Math.max(0, index - 1)];
      if (previous) focusVisibleNode(previous.id);
      return;
    }
    if (event.key === 'Home' || event.key === 'End') {
      event.preventDefault();
      const target = event.key === 'Home' ? visibleNodes[0] : visibleNodes.at(-1);
      if (target) focusVisibleNode(target.id);
      return;
    }
    if (event.key === 'ArrowRight' && hasChildren) {
      event.preventDefault();
      if (!expanded.has(node.id)) toggleExpand(node.id);
      else {
        const child = visibleNodes.find((item) => item.parentId === node.id);
        if (child) focusVisibleNode(child.id);
      }
      return;
    }
    if (event.key === 'ArrowLeft') {
      event.preventDefault();
      if (hasChildren && expanded.has(node.id)) toggleExpand(node.id);
      else if (node.parentId) focusVisibleNode(node.parentId);
      return;
    }
    if (event.key === 'Enter' || event.key === ' ') {
      event.preventDefault();
      onSelect?.(node.id);
    }
  }, [expanded, focusVisibleNode, nodes, onSelect, toggleExpand, visibleNodes]);

  // Reset menu on outside click.
  useEffect(() => {
    if (!menuFor) return;
    const handler = () => setMenuFor(null);
    window.addEventListener('click', handler);
    return () => window.removeEventListener('click', handler);
  }, [menuFor]);

  useEffect(() => {
    if (selectedId && nodes.some((node) => node.id === selectedId)) {
  // eslint-disable-next-line react-hooks/set-state-in-effect -- intentional initialization
      setFocusedId(selectedId);
    } else if (focusedId && !nodes.some((node) => node.id === focusedId)) {
      setFocusedId(nodes[0]?.id ?? null);
    }
  }, [focusedId, nodes, selectedId]);

  return (
    <div className="source-tree" role="tree" aria-label="项目资料树">
      <div className="source-tree-search">
        <input
          type="search"
          value={query}
          onChange={(e) => setQuery(e.target.value)}
          placeholder="搜索资料、笔记、成果…"
          aria-label="搜索资料树"
          className="source-tree-search-input"
        />
      </div>
      <div
        className="source-tree-viewport"
        ref={viewportRef}
        onScroll={onScroll}
        style={{ maxHeight, overflowY: 'auto', position: 'relative' }}
        role="group"
      >
        {/* Spacer to maintain scroll height for virtualization. */}
        <div style={{ height: visibleNodes.length * rowHeight, position: 'relative' }}>
          {visibleSlice.map((n, i) => {
            const idx = startIndex + i;
            const depth = depthOf(nodes, n);
            const hasChildren = nodes.some((c) => c.parentId === n.id);
            const isSelected = n.id === selectedId;
            return (
              <div
                key={n.id}
                data-testid={`node-${n.id}`}
                ref={(element) => {
                  if (element) rowRefs.current.set(n.id, element);
                  else rowRefs.current.delete(n.id);
                }}
                role="treeitem"
                aria-selected={isSelected}
                aria-expanded={hasChildren ? expanded.has(n.id) : undefined}
                aria-level={depth + 1}
                aria-label={n.status ? `${n.label}，${STATUS_LABELS[n.status]}` : n.label}
                tabIndex={focusedId === n.id ? 0 : -1}
                className={`source-tree-node kind-${n.kind} ${isSelected ? 'selected' : ''} ${n.matchedBySearch ? 'matched' : ''}`}
                onFocus={() => setFocusedId(n.id)}
                onClick={() => onSelect?.(n.id)}
                onKeyDown={(event) => handleTreeItemKeyDown(event, n)}
                onContextMenu={(event) => { event.preventDefault(); setMenuFor(n.id); }}
                style={{
                  position: 'absolute',
                  top: idx * rowHeight,
                  height: rowHeight,
                  paddingLeft: 8 + depth * 14,
                }}
              >
                {hasChildren && (
                  <button
                    className="source-tree-expand"
                    onClick={(e) => { e.stopPropagation(); toggleExpand(n.id); }}
                    aria-label={expanded.has(n.id) ? '收起' : '展开'}
                  >
                    {expanded.has(n.id) || (query && hasChildren) ? '▾' : '▸'}
                  </button>
                )}
                <span className="source-tree-label">{n.label}</span>
                {n.status && <span className={`source-tree-status status-${n.status}`} title={STATUS_LABELS[n.status]} />}
                {menuFor === n.id && renderContextMenu && (
                  <div className="source-tree-menu" onClick={(e) => e.stopPropagation()}>
                    {renderContextMenu(n)}
                  </div>
                )}
              </div>
            );
          })}
        </div>
        {visibleNodes.length === 0 && (
          <div className="source-tree-empty">无匹配资料</div>
        )}
      </div>
    </div>
  );
}

function depthOf(nodes: SourceNode[], node: SourceNode): number {
  let depth = 0;
  let p = node.parentId;
  while (p) { depth++; p = nodes.find((x) => x.id === p)?.parentId ?? null; }
  return depth;
}

export { STATUS_LABELS };
