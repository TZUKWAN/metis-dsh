/**
 * METIS-501 — ProjectShell three-column desktop tests.
 *
 * Verifies structure (three regions), the three-mode switcher, inspector tabs, collapse
 * behavior, and a11y roles. Pixel-level multi-resolution visual regression is METIS-1003.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, fireEvent, cleanup, act, waitFor } from '@testing-library/react';
import ProjectShell, { MODE_LABELS } from '../../src/shell/ProjectShell.js';

let resizeCallback: ResizeObserverCallback | null = null;

beforeEach(() => {
  resizeCallback = null;
  globalThis.ResizeObserver = class ResizeObserver {
    constructor(callback: ResizeObserverCallback) {
      resizeCallback = callback;
    }
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;
});

afterEach(() => cleanup());

function resizeShell(width: number) {
  const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
  Object.defineProperty(shell, 'clientWidth', {
    configurable: true,
    value: width,
  });
  act(() => {
    resizeCallback?.([
      {
        target: shell,
        // ResizeObserver only notifies the component. The responsive decision must
        // read clientWidth, so a conflicting contentRect cannot change the band.
        contentRect: { width: width + 100 } as DOMRectReadOnly,
      } as ResizeObserverEntry,
    ], {} as ResizeObserver);
  });
}

function renderShell(overrides: Partial<Parameters<typeof ProjectShell>[0]> = {}) {
  let mode = overrides.mode ?? 'converse';
  const onModeChange = overrides.onModeChange ?? ((m) => { mode = m; });
  const props: Parameters<typeof ProjectShell>[0] = {
    leftPanel: <div data-testid="left-content">资料树</div>,
    children: <div data-testid="center-content">工作区内容</div>,
    inspector: {
      metis: <div data-testid="metis-panel">Metis 对话</div>,
      plan: <div data-testid="plan-panel">研究计划</div>,
      evidence: <div data-testid="evidence-panel">证据列表</div>,
    },
    mode,
    onModeChange,
    ...overrides,
  };
  // keep mode state in a closure so re-render reflects changes
  const utils = render(<ProjectShell {...props} mode={mode} onModeChange={onModeChange} />);
  return { ...utils, getMode: () => mode };
}

describe('METIS-501 ProjectShell — three-column structure', () => {
  it('renders all three regions as ordered direct children of the shell', () => {
    renderShell();
    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(shell.classList.contains('project-shell')).toBe(true);
    expect(shell.children).toHaveLength(3);
    expect(shell.children[0]?.classList.contains('shell-left')).toBe(true);
    expect(shell.children[1]?.classList.contains('shell-center')).toBe(true);
    expect(shell.children[2]?.classList.contains('shell-right')).toBe(true);
    expect(screen.getByLabelText('项目与资料')).toBeDefined();
    expect(screen.getByLabelText('工作区')).toBeDefined();
    expect(screen.getByLabelText('研究检查器')).toBeDefined();
  });

  it('renders the provided left/center/right content', () => {
    renderShell();
    expect(screen.getByTestId('left-content').textContent).toBe('资料树');
    expect(screen.getByTestId('center-content').textContent).toBe('工作区内容');
    expect(screen.getByTestId('metis-panel')).toBeDefined();
  });
});

describe('METIS-501 ProjectShell — raw workspace slots', () => {
  it('renders raw right content without wrapping it in inspector tabs', () => {
    const { container } = renderShell({
      rightPanel: <div data-testid="raw-right-panel">任务、成果与笔记</div>,
      workspaceClassName: 'shell-workspace--chat',
    });

    expect(screen.getByTestId('raw-right-panel')).toBeDefined();
    expect(screen.queryByRole('tablist', { name: '检查器视图' })).toBeNull();
    expect(container.querySelector('.shell-workspace--chat')).not.toBeNull();
  });

  it('collapses and restores raw right content', () => {
    renderShell({
      rightPanel: <div data-testid="raw-right-panel">任务、成果与笔记</div>,
    });

    fireEvent.click(screen.getByLabelText('收起检查器'));
    expect(screen.queryByTestId('raw-right-panel')).toBeNull();
    fireEvent.click(screen.getByLabelText('展开检查器'));
    expect(screen.getByTestId('raw-right-panel')).toBeDefined();
  });

  it('reports controlled collapse changes without losing controlled state', () => {
    const onLeftCollapsedChange = vi.fn();
    const { rerender } = renderShell({
      leftCollapsed: false,
      onLeftCollapsedChange,
    });

    fireEvent.click(screen.getByLabelText('收起资料栏'));
    expect(onLeftCollapsedChange).toHaveBeenCalledWith(true);
    expect(screen.getByTestId('left-content')).toBeDefined();

    rerender(
      <ProjectShell
        leftPanel={<div data-testid="left-content">资料树</div>}
        inspector={{ metis: <div>Metis 对话</div> }}
        mode="converse"
        onModeChange={() => {}}
        leftCollapsed
        onLeftCollapsedChange={onLeftCollapsedChange}
      >
        <div>工作区内容</div>
      </ProjectShell>,
    );
    expect(screen.queryByTestId('left-content')).toBeNull();
  });
});

describe('METIS-501 ProjectShell — three-mode switcher', () => {
  it('renders all shell mode tabs in order', () => {
    renderShell();
    // 'projects' 是顶层科研项目工作台模式，不进入 ProjectShell 的内部切换器。
    for (const label of Object.values(MODE_LABELS)) {
      if (label === '科研项目') continue;
      expect(screen.getByText(label)).toBeDefined();
    }
  });

  it('marks the active mode with aria-selected', () => {
    renderShell({ mode: 'write' });
    const tabs = screen.getAllByRole('tab');
    const writeTab = tabs.find((t) => t.textContent === '研究写作');
    expect(writeTab?.getAttribute('aria-selected')).toBe('true');
  });

  it('fires onModeChange when a mode tab is clicked', () => {
    let changedTo: string | null = null;
    renderShell({ onModeChange: (m) => { changedTo = m; } });
    fireEvent.click(screen.getByText('研究写作'));
    expect(changedTo).toBe('write');
  });

  it('supports arrow-key mode navigation and complete tab relationships', () => {
    const onModeChange = vi.fn();
    renderShell({ mode: 'converse', onModeChange });
    const converse = screen.getByRole('tab', { name: '对话' });
    const write = screen.getByRole('tab', { name: '研究写作' });

    converse.focus();
    fireEvent.keyDown(converse, { key: 'ArrowRight' });

    expect(onModeChange).toHaveBeenCalledWith('write');
    expect(document.activeElement).toBe(write);
    const workspace = document.getElementById(converse.getAttribute('aria-controls') ?? '');
    expect(workspace).not.toBeNull();
    expect(workspace?.getAttribute('aria-label')).toBe('对话工作区');
    expect(workspace?.getAttribute('aria-labelledby')).toBe(converse.id);
  });
});

describe('METIS-501 ProjectShell — inspector tabs', () => {
  it('only renders inspector tabs that have content', () => {
    renderShell({
      inspector: { metis: <div>metis only</div> },
    });
    expect(screen.getByText('Metis')).toBeDefined();
    expect(screen.queryByText('证据')).toBeNull();
  });

  it('switches inspector body when a tab is clicked', () => {
    renderShell();
    // initially metis panel shown
    expect(screen.getByTestId('metis-panel')).toBeDefined();
    fireEvent.click(screen.getByText('证据'));
    expect(screen.getByTestId('evidence-panel')).toBeDefined();
  });

  it('supports arrow-key inspector navigation and roving focus', () => {
    renderShell();
    const metis = screen.getByRole('tab', { name: 'Metis' });
    const plan = screen.getByRole('tab', { name: '研究计划' });
    metis.focus();

    fireEvent.keyDown(metis, { key: 'ArrowRight' });

    expect(plan.getAttribute('aria-selected')).toBe('true');
    expect(plan.tabIndex).toBe(0);
    expect(metis.tabIndex).toBe(-1);
    expect(document.activeElement).toBe(plan);
    const panel = screen.getByRole('tabpanel', { name: '研究计划' });
    expect(plan.getAttribute('aria-controls')).toBe(panel.id);
    expect(panel.getAttribute('aria-labelledby')).toBe(plan.id);
  });
});

describe('METIS-501 ProjectShell — collapse behavior', () => {
  it('left collapse button toggles the panel and shell layout class', () => {
    renderShell();
    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(screen.getByTestId('left-content')).toBeDefined();
    fireEvent.click(screen.getByLabelText('收起资料栏'));
    expect(screen.queryByTestId('left-content')).toBeNull();
    expect(shell.classList.contains('left-collapsed')).toBe(true);
    fireEvent.click(screen.getByLabelText('展开资料栏'));
    expect(screen.getByTestId('left-content')).toBeDefined();
    expect(shell.classList.contains('left-collapsed')).toBe(false);
  });

  it('right collapse button toggles the panel and shell layout class', () => {
    renderShell();
    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(screen.getByTestId('metis-panel')).toBeDefined();
    fireEvent.click(screen.getByLabelText('收起检查器'));
    expect(screen.queryByTestId('metis-panel')).toBeNull();
    expect(shell.classList.contains('right-collapsed')).toBe(true);
  });

  it('reflects aria-expanded state on collapse buttons', () => {
    renderShell();
    const leftBtn = screen.getByLabelText('收起资料栏');
    expect(leftBtn.getAttribute('aria-expanded')).toBe('true');
    fireEvent.click(leftBtn);
    expect(screen.getByLabelText('展开资料栏').getAttribute('aria-expanded')).toBe('false');
  });

  it.each([
    [899, 'narrow'],
    [900, 'narrow'],
    [901, 'medium'],
    [1199, 'medium'],
    [1200, 'medium'],
    [1201, 'wide'],
  ] as const)('uses clientWidth at the exact %ipx boundary', (width, band) => {
    renderShell();

    resizeShell(width);

    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(shell.clientWidth).toBe(width);
    expect(shell.getAttribute('data-responsive-band')).toBe(band);
  });

  it('recomputes the band from clientWidth on a window resize fallback', () => {
    renderShell();
    resizeShell(1100);

    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    Object.defineProperty(shell, 'clientWidth', {
      configurable: true,
      value: 1201,
    });

    act(() => {
      window.dispatchEvent(new Event('resize'));
    });

    expect(shell.getAttribute('data-responsive-band')).toBe('wide');
  });

  it('uses a right rail without changing user preference in the medium width band', () => {
    const onRightCollapsedChange = vi.fn();
    renderShell({ onRightCollapsedChange });

    resizeShell(1100);

    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(onRightCollapsedChange).not.toHaveBeenCalled();
    expect(shell.getAttribute('data-responsive-band')).toBe('medium');
    expect(shell.classList.contains('right-collapsed')).toBe(true);
    expect(screen.getByLabelText('展开检查器').getAttribute('aria-expanded')).toBe('false');
    expect(screen.queryByTestId('metis-panel')).toBeNull();
  });

  it('uses two rails without changing user preferences in the narrow width band', () => {
    const onLeftCollapsedChange = vi.fn();
    const onRightCollapsedChange = vi.fn();
    renderShell({ onLeftCollapsedChange, onRightCollapsedChange });

    resizeShell(850);

    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(onLeftCollapsedChange).not.toHaveBeenCalled();
    expect(onRightCollapsedChange).not.toHaveBeenCalled();
    expect(shell.getAttribute('data-responsive-band')).toBe('narrow');
    expect(shell.classList.contains('left-collapsed')).toBe(true);
    expect(shell.classList.contains('right-collapsed')).toBe(true);
    expect(screen.getByLabelText('展开资料栏').getAttribute('aria-expanded')).toBe('false');
    expect(screen.getByLabelText('展开检查器').getAttribute('aria-expanded')).toBe('false');
  });

  it('reopens a responsive panel as an overlay without expanding its grid track', () => {
    renderShell();
    resizeShell(1100);
    fireEvent.click(screen.getByLabelText('展开检查器'));

    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(shell.classList.contains('right-collapsed')).toBe(true);
    expect(shell.classList.contains('right-overlay-open')).toBe(true);
    expect(screen.getByLabelText('收起检查器').getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByTestId('metis-panel')).toBeDefined();
  });

  it('closes a responsive overlay with Escape and returns focus to its rail button', async () => {
    renderShell();
    resizeShell(1100);
    const toggle = screen.getByLabelText('展开检查器');
    fireEvent.click(toggle);

    const content = screen.getByTestId('metis-panel').closest('.shell-right-content');
    expect(content).not.toBeNull();
    expect(content?.contains(document.activeElement)).toBe(true);
    fireEvent.keyDown(content as HTMLElement, { key: 'Escape' });

    const restoredToggle = screen.getByLabelText('展开检查器');
    expect(screen.queryByTestId('metis-panel')).toBeNull();
    await waitFor(() => {
      expect(document.activeElement).toBe(restoredToggle);
    });
  });

  it('restores responsive visibility when returning to the wide band', () => {
    renderShell();
    resizeShell(850);
    resizeShell(1300);

    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(shell.getAttribute('data-responsive-band')).toBe('wide');
    expect(shell.classList.contains('left-collapsed')).toBe(false);
    expect(shell.classList.contains('right-collapsed')).toBe(false);
    expect(screen.getByTestId('left-content')).toBeDefined();
    expect(screen.getByTestId('metis-panel')).toBeDefined();
  });

  it('preserves a non-default user preference across narrow and wide bands', () => {
    renderShell({ initialRightCollapsed: true });
    resizeShell(850);
    fireEvent.click(screen.getByLabelText('展开检查器'));
    fireEvent.click(screen.getByLabelText('收起检查器'));
    resizeShell(1300);

    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(shell.classList.contains('right-collapsed')).toBe(true);
    expect(screen.getByLabelText('展开检查器').getAttribute('aria-expanded')).toBe('false');
  });
});

describe('METIS-501 ProjectShell — accessibility', () => {
  it('the shell is a labelled region without creating a nested main landmark', () => {
    const { container } = renderShell();
    expect(screen.getByRole('region', { name: 'Metis 研究工作台' })).toBeDefined();
    expect(container.querySelector('.shell-center')?.tagName).toBe('SECTION');
    expect(container.querySelector('main')).toBeNull();
  });

  it('mode switcher uses tablist/tab roles', () => {
    renderShell();
    expect(screen.getByRole('tablist', { name: '工作模式' })).toBeDefined();
  });

  it('uses unique relationships for multiple shell instances', () => {
    render(
      <>
        <ProjectShell leftPanel={<div>左一</div>} mode="converse" onModeChange={() => {}}>
          <div>中一</div>
        </ProjectShell>
        <ProjectShell leftPanel={<div>左二</div>} mode="read" onModeChange={() => {}}>
          <div>中二</div>
        </ProjectShell>
      </>,
    );

    const workspaces = screen.getAllByRole('tabpanel');
    expect(new Set(workspaces.map((panel) => panel.id)).size).toBe(workspaces.length);
    const modeTabs = screen.getAllByRole('tab');
    expect(new Set(modeTabs.map((tab) => tab.id)).size).toBe(modeTabs.length);
  });
});
