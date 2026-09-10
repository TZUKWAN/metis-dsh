/**
 * KIMI-201 — ProjectShell enhanced workspace chrome behavior tests.
 *
 * Verifies that the new components render AND behave correctly: real callbacks,
 * keyboard navigation, focus management, loading/empty/error/recovery states,
 * fail-closed behavior, and basic RTL/CSS media-query contracts.
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, screen, cleanup, fireEvent, within, waitFor, act } from '@testing-library/react';
import { readFileSync } from 'node:fs';
import ProjectShell from '../../src/shell/ProjectShell.js';
import ArtifactVersionReviewActions from '../../src/shell/ArtifactVersionReviewActions.js';
import SplitPreview from '../../src/shell/SplitPreview.js';

function loadCss(relPath: string) {
  return readFileSync(new URL(relPath, import.meta.url), 'utf-8');
}

const commandBarCss = loadCss('../../src/shell/CommandBar.css');
const breadcrumbsCss = loadCss('../../src/shell/Breadcrumbs.css');
const objectTabsCss = loadCss('../../src/shell/ObjectTabs.css');
const projectSwitcherCss = loadCss('../../src/shell/ProjectSwitcher.css');
const recycleRestoreCss = loadCss('../../src/shell/RecycleRestore.css');
const runTimelineBannerCss = loadCss('../../src/shell/RunTimelineBanner.css');
const splitPreviewCss = loadCss('../../src/shell/SplitPreview.css');
const selectionActionBarCss = loadCss('../../src/shell/SelectionActionBar.css');
const artifactActionsCss = loadCss('../../src/shell/ArtifactVersionReviewActions.css');

beforeEach(() => {
  globalThis.ResizeObserver = class ResizeObserver {
    constructor() {}
    observe() {}
    unobserve() {}
    disconnect() {}
  } as unknown as typeof ResizeObserver;

  // Run requestAnimationFrame callbacks synchronously in jsdom so focus
  // management and other rAF-based UI updates are testable.
  globalThis.requestAnimationFrame = (callback: FrameRequestCallback) => {
    callback(0);
    return 0;
  };
  globalThis.cancelAnimationFrame = () => {};
});

afterEach(() => {
  cleanup();
  document.documentElement.dir = '';
});

function renderShell(overrides: Partial<Parameters<typeof ProjectShell>[0]> = {}) {
  const props: Parameters<typeof ProjectShell>[0] = {
    leftPanel: <div data-testid="left-content">资料树</div>,
    children: <div data-testid="center-content">工作区内容</div>,
    inspector: { metis: <div data-testid="metis-panel">Metis 对话</div> },
    mode: 'converse',
    onModeChange: () => {},
    ...overrides,
  };
  return render(<ProjectShell {...props} />);
}

describe('KIMI-201 ProjectShell — render-only baseline', () => {
  it('still renders the three-column shell as a direct child of the wrapper', () => {
    renderShell();
    const wrapper = document.querySelector('.project-shell-wrapper');
    expect(wrapper).not.toBeNull();
    const shell = screen.getByRole('region', { name: 'Metis 研究工作台' });
    expect(shell.classList.contains('project-shell')).toBe(true);
    expect(shell.children).toHaveLength(3);
  });

  it('renders a run timeline banner above the shell', () => {
    renderShell({
      runTimeline: {
        runs: [{ id: 'run-1', title: 'Test run', status: 'running', progress: 42 }],
      },
    });
    expect(screen.getByRole('region', { name: '执行时间线' })).toBeDefined();
    expect(screen.getByText('Test run')).toBeDefined();
    expect(screen.getByText('42%')).toBeDefined();
  });

  it('renders the workspace header with breadcrumbs and command trigger', () => {
    renderShell({
      breadcrumbs: [
        { id: 'home', label: '首页' },
        { id: 'project', label: '当前项目', current: true },
      ],
      commandBar: {
        isOpen: false,
        onOpen: () => {},
        onClose: () => {},
        commands: [],
      },
    });
    expect(screen.getByRole('navigation', { name: '面包屑导航' })).toBeDefined();
    expect(screen.getByLabelText('打开命令面板')).toBeDefined();
  });

  it('renders object tabs when provided', () => {
    renderShell({
      objectTabs: [
        { id: 't1', label: '资料 A' },
        { id: 't2', label: '资料 B' },
      ],
      activeObjectTabId: 't1',
      onObjectTabSelect: () => {},
    });
    expect(screen.getByRole('tab', { name: '资料 A' })).toBeDefined();
    expect(screen.getByRole('tab', { name: '资料 B' })).toBeDefined();
  });

  it('renders the selection action bar when items are selected', () => {
    renderShell({
      selectionActionBar: {
        selectedCount: 3,
        onClearSelection: () => {},
      },
    });
    expect(screen.getByRole('toolbar', { name: '已选择 3 个项 — 批量操作工具栏' })).toBeDefined();
  });

  it('renders the command bar overlay when open', () => {
    const onClose = vi.fn();
    renderShell({
      commandBar: {
        isOpen: true,
        onOpen: () => {},
        onClose,
        commands: [
          {
            id: 'cmd-1',
            label: '新建项目',
            group: 'project',
            onExecute: () => {},
          },
        ],
      },
    });
    expect(screen.getByRole('dialog', { name: '命令面板' })).toBeDefined();
    expect(screen.getByRole('option', { name: '新建项目' })).toBeDefined();
  });

  it('renders the import/create dialog when open', () => {
    const onClose = vi.fn();
    renderShell({
      importCreate: {
        isOpen: true,
        onOpen: () => {},
        onClose,
      },
    });
    expect(screen.getByRole('dialog')).toBeDefined();
    expect(screen.getByText('导入 / 创建')).toBeDefined();
  });

  it('renders a workspace header trigger that calls importCreate.onOpen', () => {
    const onOpen = vi.fn();
    renderShell({
      importCreate: {
        isOpen: false,
        onOpen,
        onClose: () => {},
      },
    });

    const trigger = screen.getByRole('button', { name: '导入或创建项目' });
    expect(trigger).toBeDefined();
    fireEvent.click(trigger);
    expect(onOpen).toHaveBeenCalledTimes(1);
  });

  it('renders split preview wrapper when enabled', () => {
    renderShell({
      splitPreview: {
        enabled: true,
        primary: <div data-testid="primary-pane">主面板</div>,
        secondary: <div data-testid="secondary-pane">次面板</div>,
      },
    });
    expect(screen.getByTestId('primary-pane')).toBeDefined();
    expect(screen.getByTestId('secondary-pane')).toBeDefined();
    expect(screen.getByRole('separator')).toBeDefined();
  });

  it('renders the version diff/reviewer overlay when provided', () => {
    renderShell({
      versionDiffReviewer: {
        versions: [
          { id: 'v1', label: 'v1', content: 'Line one\nLine two' },
          { id: 'v2', label: 'v2', content: 'Line one\nModified line' },
        ],
      },
    });
    expect(screen.getByRole('dialog', { name: '工作区面板' })).toBeDefined();
    expect(screen.getByRole('region', { name: '版本差异审阅' })).toBeDefined();
  });

  it('renders the recycle/restore overlay when provided', () => {
    renderShell({
      recycleRestore: {
        items: [
          {
            id: 'r1',
            title: 'Deleted note',
            entityType: 'note',
            deletedAt: Date.now(),
          },
        ],
      },
    });
    expect(screen.getByRole('dialog', { name: '工作区面板' })).toBeDefined();
    expect(screen.getByRole('region', { name: '回收站' })).toBeDefined();
  });

  it('renders a project switcher in the workspace header', () => {
    const onSwitch = vi.fn();
    renderShell({
      projectSwitcher: {
        projects: [{ id: 'p1', title: 'Project One', lifecycle: 'draft' }],
        activeProjectId: 'p1',
        onSwitch,
      },
    });
    expect(screen.getByRole('button', { name: /Project One/ })).toBeDefined();
  });
});

describe('KIMI-201 CommandBar — behavior', () => {
  it('executes the active command on Enter and closes the palette', () => {
    const onExecute = vi.fn();
    const onClose = vi.fn();
    renderShell({
      commandBar: {
        isOpen: true,
        onOpen: () => {},
        onClose,
        commands: [{ id: 'cmd-a', label: 'Alpha', group: 'g', onExecute }],
      },
    });

    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Enter' });
    expect(onExecute).toHaveBeenCalledTimes(1);
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('filters commands by query and reports no results', () => {
    const onClose = vi.fn();
    renderShell({
      commandBar: {
        isOpen: true,
        onOpen: () => {},
        onClose,
        commands: [
          { id: 'cmd-a', label: 'Alpha', group: 'g', onExecute: () => {} },
        ],
      },
    });

    const input = screen.getByRole('combobox');
    fireEvent.change(input, { target: { value: 'zzz' } });
    expect(screen.getByText('无匹配命令')).toBeDefined();
  });

  it('calls onClose on Escape', () => {
    const onClose = vi.fn();
    renderShell({
      commandBar: {
        isOpen: true,
        onOpen: () => {},
        onClose,
        commands: [],
      },
    });

    const input = screen.getByRole('combobox');
    fireEvent.keyDown(input, { key: 'Escape' });
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry when the error retry button is clicked', () => {
    const onRetry = vi.fn();
    renderShell({
      commandBar: {
        isOpen: true,
        onOpen: () => {},
        onClose: () => {},
        commands: [],
        error: '加载失败',
        onRetry,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });
});

describe('KIMI-201 ProjectSwitcher — behavior', () => {
  it('selects a project with keyboard ArrowDown + Enter', async () => {
    const onSwitch = vi.fn();
    renderShell({
      projectSwitcher: {
        projects: [
          { id: 'p1', title: 'Alpha', lifecycle: 'draft' },
          { id: 'p2', title: 'Beta', lifecycle: 'running' },
        ],
        activeProjectId: 'p1',
        onSwitch,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
    const search = screen.getByRole('searchbox');
    fireEvent.keyDown(search, { key: 'ArrowDown' });
    fireEvent.keyDown(search, { key: 'ArrowDown' });

    const option = screen.getByRole('option', { name: /Beta/ });
    option.focus();
    await act(async () => {
      fireEvent.keyDown(option, { key: 'Enter' });
    });

    // ProjectShell enables the confirmation guard; Enter only opens confirmation.
    expect(onSwitch).toHaveBeenCalledTimes(0);
    const confirmButton = await screen.findByRole('button', { name: '确认切换' });
    await act(async () => {
      fireEvent.click(confirmButton);
    });
    await waitFor(() => expect(onSwitch).toHaveBeenCalledTimes(1));
    expect(onSwitch).toHaveBeenCalledWith('p2');
  });

  it('supports Home and End to move focus in the option list', () => {
    renderShell({
      projectSwitcher: {
        projects: [
          { id: 'p1', title: 'Alpha', lifecycle: 'draft' },
          { id: 'p2', title: 'Beta', lifecycle: 'running' },
        ],
        activeProjectId: 'p1',
        onSwitch: () => {},
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
    const options = screen.getAllByRole('option');
    options[0]!.focus();
    fireEvent.keyDown(options[0]!, { key: 'End' });
    expect(document.activeElement).toBe(options[options.length - 1]);
    fireEvent.keyDown(options[options.length - 1]!, { key: 'Home' });
    expect(document.activeElement).toBe(options[0]);
  });

  it('filters the project list by search query', () => {
    renderShell({
      projectSwitcher: {
        projects: [
          { id: 'p1', title: 'Alpha', lifecycle: 'draft' },
          { id: 'p2', title: 'Beta', lifecycle: 'running' },
        ],
        activeProjectId: 'p1',
        onSwitch: () => {},
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /Alpha/ }));
    const search = screen.getByRole('searchbox');
    fireEvent.change(search, { target: { value: 'bet' } });
    expect(screen.queryByRole('option', { name: /Alpha/ })).toBeNull();
    expect(screen.getByRole('option', { name: /Beta/ })).toBeDefined();
  });

  it('shows empty state when no projects match', () => {
    renderShell({
      projectSwitcher: {
        projects: [],
        activeProjectId: null,
        onSwitch: () => {},
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /暂无项目/ }));
    const listbox = screen.getByRole('listbox', { name: '切换项目' });
    expect(within(listbox).getByText('暂无项目')).toBeDefined();
  });

  it('shows error state and retry', () => {
    const onRefresh = vi.fn();
    renderShell({
      projectSwitcher: {
        projects: [],
        activeProjectId: null,
        onSwitch: () => {},
        error: '加载失败',
        onRefresh,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: /暂无项目/ }));
    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('KIMI-201 ObjectTabs — behavior', () => {
  it('roves focus and selects the next tab with ArrowRight', () => {
    const onSelect = vi.fn();
    renderShell({
      objectTabs: [
        { id: 't1', label: 'Tab 1' },
        { id: 't2', label: 'Tab 2' },
      ],
      activeObjectTabId: 't1',
      onObjectTabSelect: onSelect,
    });

    const tablist = screen.getByRole('tablist', { name: '对象标签页' });
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('reverses ArrowRight direction in RTL mode', () => {
    document.documentElement.dir = 'rtl';
    const onSelect = vi.fn();
    renderShell({
      objectTabs: [
        { id: 't1', label: 'Tab 1' },
        { id: 't2', label: 'Tab 2' },
      ],
      activeObjectTabId: 't2',
      onObjectTabSelect: onSelect,
    });

    const tablist = screen.getByRole('tablist', { name: '对象标签页' });
    fireEvent.keyDown(tablist, { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith('t1');
  });

  it('calls onClose when the close button is clicked', async () => {
    const onClose = vi.fn();
    renderShell({
      objectTabs: [{ id: 't1', label: 'Tab 1' }],
      activeObjectTabId: 't1',
      onObjectTabSelect: () => {},
      onObjectTabClose: onClose,
    });

    fireEvent.click(screen.getByRole('button', { name: '关闭Tab 1' }));
    await waitFor(() => expect(onClose).toHaveBeenCalledWith('t1'));
  });

  it('exposes dirty state in the tab aria-label', () => {
    renderShell({
      objectTabs: [{ id: 't1', label: 'Tab 1', dirty: true }],
      activeObjectTabId: 't1',
      onObjectTabSelect: () => {},
    });

    expect(screen.getByRole('tab', { name: /未保存/ })).toBeDefined();
  });
});

describe('KIMI-201 RunTimelineBanner — behavior', () => {
  it('calls onResume and onTerminate via action buttons', () => {
    const onResume = vi.fn();
    const onTerminate = vi.fn();
    renderShell({
      runTimeline: {
        runs: [
          { id: 'r1', title: 'Recoverable', status: 'recoverable' },
          { id: 'r2', title: 'Running', status: 'running' },
        ],
        onResume,
        onTerminate,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '恢复运行 Recoverable' }));
    expect(onResume).toHaveBeenCalledWith('r1');

    fireEvent.click(screen.getByRole('button', { name: '终止运行 Running' }));
    expect(onTerminate).toHaveBeenCalledWith('r2');
  });

  it('resumes all recoverable runs from the recovery banner', () => {
    const onResume = vi.fn();
    renderShell({
      runTimeline: {
        runs: [
          { id: 'r1', title: 'A', status: 'recoverable' },
          { id: 'r2', title: 'B', status: 'failed' },
        ],
        onResume,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '恢复所有可恢复运行' }));
    expect(onResume).toHaveBeenCalledWith('r1');
    expect(onResume).toHaveBeenCalledWith('r2');
    expect(onResume).toHaveBeenCalledTimes(2);
  });

  it('gates keyboard shortcuts by run status: resume only recoverable/failed, terminate only running/pending', () => {
    const onResume = vi.fn();
    const onTerminate = vi.fn();
    renderShell({
      runTimeline: {
        runs: [
          { id: 'r1', title: 'Recoverable', status: 'recoverable' },
          { id: 'r2', title: 'Running', status: 'running' },
        ],
        onResume,
        onTerminate,
      },
    });

    const items = screen.getAllByRole('listitem');
    const recoverableItem = items.find((el) => el.textContent?.includes('Recoverable'))!;
    const runningItem = items.find((el) => el.textContent?.includes('Running'))!;

    recoverableItem.focus();
    fireEvent.keyDown(recoverableItem, { key: 'r' });
    expect(onResume).toHaveBeenCalledWith('r1');

    fireEvent.keyDown(recoverableItem, { key: 'Delete' });
    expect(onTerminate).not.toHaveBeenCalled();

    runningItem.focus();
    fireEvent.keyDown(runningItem, { key: 'Delete' });
    expect(onTerminate).toHaveBeenCalledWith('r2');

    fireEvent.keyDown(runningItem, { key: 'r' });
    expect(onResume).toHaveBeenCalledTimes(1);
  });
});

describe('KIMI-201 VersionDiffReviewer — behavior', () => {
  it('calls base/target change callbacks when selects change', () => {
    const onBase = vi.fn();
    const onTarget = vi.fn();
    renderShell({
      versionDiffReviewer: {
        versions: [
          { id: 'v1', label: 'v1', content: 'a' },
          { id: 'v2', label: 'v2', content: 'b' },
        ],
        onBaseVersionChange: onBase,
        onTargetVersionChange: onTarget,
      },
    });

    const baseSelect = screen.getByLabelText('基线');
    const targetSelect = screen.getByLabelText('目标');

    fireEvent.change(baseSelect, { target: { value: 'v1' } });
    expect(onBase).toHaveBeenCalledWith('v1');

    fireEvent.change(targetSelect, { target: { value: 'v2' } });
    expect(onTarget).toHaveBeenCalledWith('v2');
  });

  it('calls approve/reject/request-changes callbacks', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onReject = vi.fn().mockResolvedValue(undefined);
    const onRequestChanges = vi.fn().mockResolvedValue(undefined);
    renderShell({
      versionDiffReviewer: {
        versions: [
          { id: 'v1', label: 'v1', content: 'a' },
          { id: 'v2', label: 'v2', content: 'b' },
        ],
        baseVersionId: 'v1',
        targetVersionId: 'v2',
        onApprove,
        onReject,
        onRequestChanges,
      },
    });

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /批准/ }));
    });
    expect(onApprove).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /拒绝/ }));
    });
    expect(onReject).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /要求修改/ }));
    });
    expect(onRequestChanges).toHaveBeenCalledTimes(1);
  });

  it('submits a new review comment via onAddReviewComment', () => {
    const onAdd = vi.fn();
    renderShell({
      versionDiffReviewer: {
        versions: [
          { id: 'v1', label: 'v1', content: 'a' },
          { id: 'v2', label: 'v2', content: 'b' },
        ],
        targetVersionId: 'v2',
        onAddReviewComment: onAdd,
      },
    });

    const textarea = screen.getByPlaceholderText('输入批注内容，按 Ctrl+Enter 提交…');
    fireEvent.change(textarea, { target: { value: 'fix typo' } });
    fireEvent.click(screen.getByRole('button', { name: '提交批注' }));
    expect(onAdd).toHaveBeenCalledWith({ line: undefined, text: 'fix typo' });
  });
});

describe('KIMI-201 RecycleRestore — behavior', () => {
  it('calls onRestore with selected ids, clears selection, and shows success banner', async () => {
    const onRestore = vi.fn();
    renderShell({
      recycleRestore: {
        items: [
          { id: 'r1', title: 'Note A', entityType: 'note', deletedAt: Date.now() },
          { id: 'r2', title: 'Note B', entityType: 'note', deletedAt: Date.now() },
        ],
        onRestore,
      },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Note A' }));

    const restoreButton = screen.getByRole('button', { name: '恢复' });
    fireEvent.click(restoreButton);
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(['r1']));
    await waitFor(() => expect(screen.getByText(/已成功恢复 1 个项目/)).toBeDefined());
    expect(screen.queryByRole('toolbar', { name: '已选项操作' })).toBeNull();
  });

  it('calls onDeleteForever with selected ids', async () => {
    const onDeleteForever = vi.fn();
    renderShell({
      recycleRestore: {
        items: [
          { id: 'r1', title: 'Note A', entityType: 'note', deletedAt: Date.now() },
        ],
        onDeleteForever,
      },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Note A' }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(onDeleteForever).toHaveBeenCalledWith(['r1']));
  });

  it('keeps restore for protected items and filters them out of batch permanent deletion', async () => {
    const onRestore = vi.fn();
    const onDeleteForever = vi.fn();
    renderShell({
      recycleRestore: {
        items: [
          {
            id: 'protected-image',
            title: 'Protected Image',
            entityType: 'source',
            deletedAt: Date.now(),
            allowPermanentDelete: false,
          },
          { id: 'regular-note', title: 'Regular Note', entityType: 'note', deletedAt: Date.now() },
        ],
        onRestore,
        onDeleteForever,
      },
    });

    const protectedRow = screen.getByText('Protected Image').closest('.recycle-restore__item');
    expect(protectedRow).not.toBeNull();
    if (!protectedRow) return;
    expect(protectedRow.querySelector('.recycle-restore__icon-btn--restore')).not.toBeNull();
    expect(protectedRow.querySelector('.recycle-restore__icon-btn--danger')).toBeNull();
    fireEvent.click(within(protectedRow).getByRole('button', { name: '恢复 Protected Image' }));
    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(['protected-image']));

    fireEvent.click(screen.getByRole('checkbox', { name: '全选' }));
    fireEvent.click(screen.getByRole('button', { name: '永久删除' }));
    expect(screen.getByText(/即将永久删除 1 个项目/)).toBeDefined();
    fireEvent.click(screen.getByRole('button', { name: '确认删除' }));
    await waitFor(() => expect(onDeleteForever).toHaveBeenCalledWith(['regular-note']));
    expect(onDeleteForever).not.toHaveBeenCalledWith(expect.arrayContaining(['protected-image']));
  });

  it('is fail-closed: no restore/delete buttons when callbacks are missing', () => {
    renderShell({
      recycleRestore: {
        items: [{ id: 'r1', title: 'Note A', entityType: 'note', deletedAt: Date.now() }],
      },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Note A' }));
    expect(screen.queryByRole('button', { name: '恢复' })).toBeNull();
    expect(screen.queryByRole('button', { name: '永久删除' })).toBeNull();
  });

  it('calls onRefresh when the retry button is clicked', () => {
    const onRefresh = vi.fn();
    renderShell({
      recycleRestore: {
        items: [],
        error: '加载失败',
        onRefresh,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRefresh).toHaveBeenCalledTimes(1);
  });
});

describe('KIMI-201 ImportCreateDialog — behavior', () => {
  it('fails explicitly when create handler is missing', async () => {
    renderShell({
      importCreate: {
        isOpen: true,
        onOpen: () => {},
        onClose: () => {},
      },
    });

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /创建项目/ }));
    const nameInput = screen.getByPlaceholderText('例如：生成式 AI 对科研写作的影响');
    fireEvent.change(nameInput, { target: { value: 'New Project' } });
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));
    await waitFor(() =>
      expect(screen.getAllByText('创建接口尚未接入，无法保存项目。')[0]).toBeDefined(),
    );
  });

  it('fails explicitly when import handler is missing', async () => {
    renderShell({
      importCreate: {
        isOpen: true,
        onOpen: () => {},
        onClose: () => {},
      },
    });

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /导入文件/ }));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['{}'], 'data.json', { type: 'application/json' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    // Wait for the FileReader-based validation to mark the file as ready.
    await screen.findByText('已就绪');

    fireEvent.click(screen.getByRole('button', { name: '下一步' }));
    await waitFor(() =>
      expect(screen.getAllByText('导入接口尚未接入，无法上传文件。')[0]).toBeDefined(),
    );
  });

  it('creates a project with payload, shows success, and closes on done', async () => {
    const onClose = vi.fn();
    const onCreateProject = vi.fn().mockResolvedValue({ success: true, projectId: 'proj-123' });
    renderShell({
      importCreate: {
        isOpen: true,
        onOpen: () => {},
        onClose,
        onCreateProject,
      },
    });

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /创建项目/ }));
    fireEvent.change(screen.getByPlaceholderText('例如：生成式 AI 对科研写作的影响'), {
      target: { value: 'Test Project' },
    });
    fireEvent.change(screen.getByPlaceholderText('一句话记录研究目标或背景'), {
      target: { value: 'A description' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() => expect(screen.getByText('项目已创建')).toBeDefined());
    expect(onCreateProject).toHaveBeenCalledWith({
      name: 'Test Project',
      description: 'A description',
    });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('imports files with payload, shows success, and closes on done', async () => {
    const onClose = vi.fn();
    const onImportFiles = vi.fn().mockResolvedValue({ success: true, imported: ['data.json'] });
    renderShell({
      importCreate: {
        isOpen: true,
        onOpen: () => {},
        onClose,
        onImportFiles,
      },
    });

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /导入文件/ }));
    const fileInput = document.querySelector('input[type="file"]') as HTMLInputElement;
    const file = new File(['{}'], 'data.json', { type: 'application/json' });
    fireEvent.change(fileInput, { target: { files: [file] } });

    await screen.findByText('已就绪');
    fireEvent.click(screen.getByRole('button', { name: '下一步' }));

    await waitFor(() => expect(screen.getByText('导入完成')).toBeDefined());
    expect(onImportFiles).toHaveBeenCalledWith([file], { projectId: undefined });
    fireEvent.click(screen.getByRole('button', { name: '完成' }));
    expect(onClose).toHaveBeenCalledTimes(1);
  });
});

describe('KIMI-201 SplitPreview — behavior', () => {
  it('changes split via keyboard ArrowRight and calls onSplitChange', () => {
    const onSplitChange = vi.fn();
    renderShell({
      splitPreview: {
        enabled: true,
        primary: <div>primary</div>,
        secondary: <div>secondary</div>,
        onSplitChange,
      },
    });

    const sash = screen.getByRole('separator');
    fireEvent.keyDown(sash, { key: 'ArrowRight' });
    expect(onSplitChange).toHaveBeenCalled();
    const value = onSplitChange.mock.calls[0]![0] as number;
    expect(value).toBeGreaterThan(50);
  });

  it('toggles primary collapsed via toolbar button and calls callback', () => {
    const onPrimaryCollapsedChange = vi.fn();
    renderShell({
      splitPreview: {
        enabled: true,
        primary: <div>primary</div>,
        secondary: <div>secondary</div>,
        onPrimaryCollapsedChange,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '折叠主面板' }));
    expect(onPrimaryCollapsedChange).toHaveBeenCalledWith(true);
  });
});

describe('KIMI-201 SelectionActionBar — behavior', () => {
  it('calls delete and restore callbacks', () => {
    const onDelete = vi.fn();
    const onRestore = vi.fn();
    renderShell({
      selectionActionBar: {
        selectedCount: 2,
        onClearSelection: () => {},
        onDeleteSelected: onDelete,
        onRestoreSelected: onRestore,
      },
    });

    const toolbar = screen.getByRole('toolbar', { name: '已选择 2 个项 — 批量操作工具栏' });
    fireEvent.click(within(toolbar).getByRole('button', { name: '删除已选择的项' }));
    expect(onDelete).toHaveBeenCalledTimes(1);

    fireEvent.click(within(toolbar).getByRole('button', { name: '恢复已选择的项' }));
    expect(onRestore).toHaveBeenCalledTimes(1);
  });

  it('calls onRetry when error retry is clicked', () => {
    const onRetry = vi.fn();
    renderShell({
      selectionActionBar: {
        selectedCount: 1,
        onClearSelection: () => {},
        error: '删除失败',
        onRetry,
      },
    });

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(onRetry).toHaveBeenCalledTimes(1);
  });

  it('captures a synchronous throw, displays the error, and retries', async () => {
    const onDelete = vi.fn(() => {
      throw new Error('sync boom');
    });
    renderShell({
      selectionActionBar: {
        selectedCount: 1,
        onClearSelection: () => {},
        onDeleteSelected: onDelete,
      },
    });

    const deleteButton = screen.getByRole('button', { name: '删除已选择的项' });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(screen.getByText('sync boom')).toBeDefined());
    expect(deleteButton.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
  });

  it('captures a rejected promise, displays the error, clears pending, and retries', async () => {
    const onDelete = vi.fn().mockRejectedValue(new Error('async boom'));
    renderShell({
      selectionActionBar: {
        selectedCount: 1,
        onClearSelection: () => {},
        onDeleteSelected: onDelete,
      },
    });

    const deleteButton = screen.getByRole('button', { name: '删除已选择的项' });
    fireEvent.click(deleteButton);
    await waitFor(() => expect(screen.getByText('async boom')).toBeDefined());
    expect(deleteButton.disabled).toBe(false);

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    await waitFor(() => expect(onDelete).toHaveBeenCalledTimes(2));
  });
});

describe('KIMI-201 accessibility / CSS contracts', () => {
  it('ObjectTabs reverses keyboard direction under RTL', () => {
    document.documentElement.dir = 'rtl';
    const onSelect = vi.fn();
    renderShell({
      objectTabs: [
        { id: 't1', label: 'One' },
        { id: 't2', label: 'Two' },
      ],
      activeObjectTabId: 't1',
      onObjectTabSelect: onSelect,
    });

    fireEvent.keyDown(screen.getByRole('tablist', { name: '对象标签页' }), { key: 'ArrowRight' });
    expect(onSelect).toHaveBeenCalledWith('t2');
  });

  it('stylesheet files include reduced-motion and forced-colors media queries', () => {
    const sheets = [
      commandBarCss,
      breadcrumbsCss,
      objectTabsCss,
      projectSwitcherCss,
      recycleRestoreCss,
      runTimelineBannerCss,
      splitPreviewCss,
      selectionActionBarCss,
      artifactActionsCss,
    ];

    for (const css of sheets) {
      expect(css).toMatch(/@media\s*\(\s*prefers-reduced-motion\s*:\s*reduce\s*\)/);
      expect(css).toMatch(/@media\s*\(\s*forced-colors\s*:\s*active\s*\)/);
    }
  });

  it('sets data-responsive-band narrow and removes sash in narrow SplitPreview', () => {
    render(
      <SplitPreview
        primary={<div>primary</div>}
        secondary={<div>secondary</div>}
        responsiveBand="narrow"
      />,
    );

    const split = screen.getByRole('region', { name: '分栏预览' });
    expect(split.getAttribute('data-responsive-band')).toBe('narrow');
    expect(screen.queryByRole('separator')).toBeNull();
  });

  it('renders long object tabs without overflow crash', () => {
    renderShell({
      objectTabs: Array.from({ length: 30 }, (_, i) => ({
        id: `t${i}`,
        label: `Tab ${i}`,
      })),
      activeObjectTabId: 't0',
      onObjectTabSelect: () => {},
    });

    const objectTablist = screen.getByRole('tablist', { name: '对象标签页' });
    expect(within(objectTablist).getAllByRole('tab').length).toBe(30);
  });
});

describe('KIMI-201 ArtifactVersionReviewActions — independent behavior', () => {
  it('calls approve/reject/request-changes callbacks with target version', async () => {
    const onApprove = vi.fn().mockResolvedValue(undefined);
    const onReject = vi.fn().mockResolvedValue(undefined);
    const onRequestChanges = vi.fn().mockResolvedValue(undefined);
    render(
      <ArtifactVersionReviewActions
        targetVersion={{ id: 'v2', label: 'v2', content: 'b' }}
        baseVersion={{ id: 'v1', label: 'v1', content: 'a' }}
        onApprove={onApprove}
        onReject={onReject}
        onRequestChanges={onRequestChanges}
      />,
    );

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /批准/ }));
    });
    expect(onApprove).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /拒绝/ }));
    });
    expect(onReject).toHaveBeenCalledTimes(1);

    await act(async () => {
      fireEvent.click(screen.getByRole('button', { name: /要求修改/ }));
    });
    expect(onRequestChanges).toHaveBeenCalledTimes(1);
  });

  it('is disabled when target version is missing', () => {
    render(<ArtifactVersionReviewActions />);
    expect(screen.getByRole('button', { name: /批准/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /拒绝/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /要求修改/ }).hasAttribute('disabled')).toBe(true);
  });

  it('hides actions whose callbacks are missing (fail-closed)', () => {
    render(
      <ArtifactVersionReviewActions
        targetVersion={{ id: 'v1', label: 'v1', content: 'a' }}
        onApprove={() => {}}
      />,
    );
    expect(screen.getByRole('button', { name: /批准/ }).hasAttribute('disabled')).toBe(false);
    expect(screen.getByRole('button', { name: /拒绝/ }).hasAttribute('disabled')).toBe(true);
    expect(screen.getByRole('button', { name: /要求修改/ }).hasAttribute('disabled')).toBe(true);
  });
});

describe('KIMI-201 RecycleRestore — callback throw fail-closed', () => {
  it('keeps selection and does not show success banner when onRestore throws', async () => {
    const onRestore = vi.fn().mockRejectedValue(new Error('boom'));
    renderShell({
      recycleRestore: {
        items: [{ id: 'r1', title: 'Note A', entityType: 'note', deletedAt: Date.now() }],
        onRestore,
      },
    });

    fireEvent.click(screen.getByRole('checkbox', { name: '选择 Note A' }));
    fireEvent.click(screen.getByRole('button', { name: '恢复' }));

    await waitFor(() => expect(onRestore).toHaveBeenCalledWith(['r1']));
    // Selection must remain because the callback failed (fail-closed).
    expect(screen.getByRole('button', { name: '恢复' })).toBeDefined();
    expect(screen.queryByText(/已成功恢复/)).toBeNull();
  });
});

describe('KIMI-201 SplitPreview — extended keyboard control', () => {
  it('moves split to min/max with Home/End and pages with PageUp/PageDown', () => {
    const onSplitChange = vi.fn();
    renderShell({
      splitPreview: {
        enabled: true,
        primary: <div>primary</div>,
        secondary: <div>secondary</div>,
        onSplitChange,
      },
    });

    const sash = screen.getByRole('separator');

    fireEvent.keyDown(sash, { key: 'Home' });
    expect(onSplitChange).toHaveBeenLastCalledWith(20);

    fireEvent.keyDown(sash, { key: 'PageDown' });
    expect(onSplitChange).toHaveBeenLastCalledWith(30);

    fireEvent.keyDown(sash, { key: 'PageUp' });
    expect(onSplitChange).toHaveBeenLastCalledWith(20);

    fireEvent.keyDown(sash, { key: 'End' });
    expect(onSplitChange).toHaveBeenLastCalledWith(80);
  });
});

describe('KIMI-201 ImportCreateDialog — error recovery', () => {
  it('returns to the create form when retry is clicked on a create error', async () => {
    renderShell({
      importCreate: {
        isOpen: true,
        onOpen: () => {},
        onClose: () => {},
      },
    });

    fireEvent.click(within(screen.getByRole('dialog')).getByRole('button', { name: /创建项目/ }));
    fireEvent.change(screen.getByPlaceholderText('例如：生成式 AI 对科研写作的影响'), {
      target: { value: 'X' },
    });
    fireEvent.click(screen.getByRole('button', { name: '创建项目' }));

    await waitFor(() =>
      expect(screen.getAllByText('创建接口尚未接入，无法保存项目。')[0]).toBeDefined(),
    );

    fireEvent.click(screen.getByRole('button', { name: '重试' }));
    expect(screen.getByPlaceholderText('例如：生成式 AI 对科研写作的影响')).toBeDefined();
  });
});
