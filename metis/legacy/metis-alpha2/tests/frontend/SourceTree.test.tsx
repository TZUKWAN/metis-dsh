/**
 * METIS-502 — SourceTree tests.
 *
 * Covers: rendering, search filter, expand/collapse, selection, status indicator, context
 * menu, and virtual-scroll windowing (large node sets render a bounded slice, not all).
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach } from 'vitest';
import { render, screen, fireEvent, cleanup } from '@testing-library/react';
import SourceTree, { type SourceNode } from '../../src/shell/SourceTree.js';

afterEach(() => cleanup());

function makeNodes(count: number): SourceNode[] {
  const nodes: SourceNode[] = [{ id: 'p1', kind: 'project', label: '项目', parentId: null }];
  for (let i = 0; i < count; i++) {
    nodes.push({ id: `s${i}`, kind: 'source', label: `资料 ${i}`, parentId: 'p1', status: i % 2 === 0 ? 'unread' : 'read' });
  }
  return nodes;
}

describe('METIS-502 SourceTree — rendering', () => {
  it('renders project + source nodes', () => {
    render(<SourceTree nodes={makeNodes(3)} />);
    expect(screen.getByText('项目')).toBeDefined();
    expect(screen.getByText('资料 0')).toBeDefined();
  });

  it('renders status indicators', () => {
    const { container } = render(<SourceTree nodes={makeNodes(2)} />);
    expect(container.querySelectorAll('.status-unread').length).toBeGreaterThan(0);
    expect(container.querySelectorAll('.status-read').length).toBeGreaterThan(0);
  });
});

describe('METIS-502 SourceTree — search filter', () => {
  it('filters nodes by label', () => {
    render(<SourceTree nodes={makeNodes(5)} />);
    const input = screen.getByLabelText('搜索资料树');
    fireEvent.change(input, { target: { value: '资料 3' } });
    expect(screen.queryByText('资料 0')).toBeNull();
    expect(screen.getByText('资料 3')).toBeDefined();
  });

  it('shows empty state when no match', () => {
    render(<SourceTree nodes={makeNodes(2)} />);
    fireEvent.change(screen.getByLabelText('搜索资料树'), { target: { value: '不存在的资料' } });
    expect(screen.getByText('无匹配资料')).toBeDefined();
  });
});

describe('METIS-502 SourceTree — expand/collapse + selection', () => {
  it('collapses and expands the project node', () => {
    render(<SourceTree nodes={makeNodes(2)} />);
    expect(screen.getByText('资料 0')).toBeDefined();
    fireEvent.click(screen.getByLabelText('收起'));
    expect(screen.queryByText('资料 0')).toBeNull();
    fireEvent.click(screen.getByLabelText('展开'));
    expect(screen.getByText('资料 0')).toBeDefined();
  });

  it('fires onSelect when a node label is clicked', () => {
    let selected: string | null = null;
    render(<SourceTree nodes={makeNodes(2)} onSelect={(id) => { selected = id; }} />);
    fireEvent.click(screen.getByText('资料 1'));
    expect(selected).toBe('s1');
  });

  it('marks the selected node with aria-selected', () => {
    render(<SourceTree nodes={makeNodes(2)} selectedId="s1" />);
    const node = screen.getByTestId('node-s1');
    expect(node.getAttribute('aria-selected')).toBe('true');
  });
});

describe('METIS-502 SourceTree — context menu', () => {
  it('opens a custom context menu on right-click', () => {
    render(
      <SourceTree
        nodes={makeNodes(1)}
        renderContextMenu={(n) => <button data-testid={`menu-open-${n.id}`}>打开</button>}
      />,
    );
    fireEvent.contextMenu(screen.getByText('资料 0'));
    expect(screen.getByTestId('menu-open-s0')).toBeDefined();
  });
});

describe('METIS-502 SourceTree — virtual scroll (performance)', () => {
  it('does NOT render all 5000 nodes in the DOM (windowed)', () => {
    const { container } = render(<SourceTree nodes={makeNodes(5000)} rowHeight={28} maxHeight={300} />);
    const renderedRows = container.querySelectorAll('[role="treeitem"]');
    // Should be far fewer than 5000 (only the viewport window + overscan).
    expect(renderedRows.length).toBeLessThan(200);
    expect(renderedRows.length).toBeGreaterThan(0);
  });

  it('renders 100 nodes correctly (search reaches the last node even off-screen)', () => {
    render(<SourceTree nodes={makeNodes(100)} maxHeight={400} />);
    // Node 99 is below the fold under virtual scroll; search flattens + forces it visible.
    fireEvent.change(screen.getByLabelText('搜索资料树'), { target: { value: '资料 99' } });
    expect(screen.getByText('资料 99')).toBeDefined();
  });

  it('renders 1 node correctly', () => {
    render(<SourceTree nodes={[{ id: 'p1', kind: 'project', label: '单项目', parentId: null }]} />);
    expect(screen.getByText('单项目')).toBeDefined();
  });
});
