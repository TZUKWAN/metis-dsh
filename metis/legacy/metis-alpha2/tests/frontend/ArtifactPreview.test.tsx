/**
 * @vitest-environment jsdom
 */

import { useState } from 'react';
import { describe, it, expect, afterEach, vi } from 'vitest';
import {
  render,
  screen,
  cleanup,
  fireEvent,
} from '@testing-library/react';
import RightPanel, {
  type RightPanelProps,
  type RightPanelTab,
} from '../../src/components/RightPanel.js';

afterEach(() => cleanup());

function ControlledRightPanel({
  initialTab = 'tasks',
  ...props
}: Omit<RightPanelProps, 'activeTab' | 'onActiveTabChange'> & {
  initialTab?: RightPanelTab;
}) {
  const [activeTab, setActiveTab] = useState<RightPanelTab>(initialTab);
  return (
    <RightPanel
      {...props}
      activeTab={activeTab}
      onActiveTabChange={setActiveTab}
    />
  );
}

describe('P0 Artifact 实时预览', () => {
  it('由父级选择 artifacts tab 时渲染实时预览', () => {
    const { container } = render(
      <ControlledRightPanel
        initialTab="artifacts"
        previewContent="# 测试标题\n\n这是预览内容"
      />,
    );

    expect(container.querySelector('.artifact-live-preview')).not.toBeNull();
    expect(container.querySelector('h1')?.textContent).toContain('测试标题');
  });

  it('渲染 Markdown 内容（标题、列表、代码块）', () => {
    const md = '# 标题\n\n- 列表项1\n- 列表项2\n\n`code`';
    const { container } = render(
      <ControlledRightPanel initialTab="artifacts" previewContent={md} />,
    );
    expect(container.querySelector('h1')).not.toBeNull();
    expect(container.querySelectorAll('li').length).toBeGreaterThanOrEqual(2);
    expect(container.querySelector('code')).not.toBeNull();
  });

  it('渲染表格', () => {
    const md = '| 列1 | 列2 |\n|-----|-----|\n| A | B |';
    const { container } = render(
      <ControlledRightPanel initialTab="artifacts" previewContent={md} />,
    );
    expect(container.querySelector('table')).not.toBeNull();
    expect(container.querySelectorAll('td').length).toBeGreaterThanOrEqual(2);
  });

  it('显示预览标题', () => {
    render(
      <ControlledRightPanel
        initialTab="artifacts"
        previewContent="内容"
        previewTitle="AI 生成预览"
      />,
    );
    expect(screen.getByText('AI 生成预览')).toBeDefined();
  });

  it('成果名称只在可见文本和可访问名称中显示安全文件名', () => {
    const { container } = render(
      <ControlledRightPanel
        initialTab="artifacts"
        artifacts={[
          {
            id: 'artifact-path',
            name: 'C:\\Users\\researcher\\private\\field-notes.md',
            type: 'md',
            contentAvailable: true,
          },
          {
            id: 'artifact-url',
            name: 'https://user:password@example.test/private/source.pdf?token=secret#fragment',
            type: 'pdf',
            contentAvailable: true,
          },
        ]}
        onArtifactClick={() => {}}
      />,
    );

    expect(screen.getByRole('button', { name: 'field-notes.md' })).toBeDefined();
    expect(screen.getByRole('button', { name: 'source.pdf' })).toBeDefined();
    const rendered = container.outerHTML;
    for (const leaked of [
      'C:\\Users\\researcher',
      'user:password',
      'token=secret',
      '#fragment',
    ]) {
      expect(rendered).not.toContain(leaked);
    }
  });

  it('任务标题在可见文本和 ARIA 中共享同一安全边界', () => {
    const rawTask = 'C:\\Users\\researcher\\private\\task Authorization: Bearer task-secret-marker';
    const { container } = render(
      <ControlledRightPanel
        initialTab="tasks"
        tasks={[{ id: 'task-1', title: rawTask, status: 'running', progress: 10 }]}
        onTaskClick={() => {}}
      />,
    );

    const taskButton = screen.getByRole('button', { name: /本地路径已隐藏/ });
    expect(taskButton.getAttribute('aria-label')).toBeNull();
    // 右面板现只有「任务/生成物」两个视图（笔记视图已迁移），任务标题的
    // 路径与凭据必须在所有可观测文本中完成净化。
    const observable = container.outerHTML;
    for (const marker of [
      'C:\\Users\\researcher',
      'task-secret-marker',
    ]) {
      expect(observable).not.toContain(marker);
    }
  });

  it('嵌入 ProjectShell 时不创建嵌套 aside 地标', () => {
    const { container } = render(<ControlledRightPanel embedded />);
    const panel = container.querySelector('.right-panel--embedded');
    expect(panel?.tagName).toBe('DIV');
    expect(container.querySelector('aside')).toBeNull();
  });

  it('为侧栏切换提供 tablist、tab 与 tabpanel 语义', () => {
    render(<ControlledRightPanel />);

    const tablist = screen.getByRole('tablist', { name: '研究侧栏' });
    const artifactsTab = screen.getByRole('tab', { name: '生成物' });
    expect(tablist).toBeDefined();
    expect(artifactsTab.getAttribute('aria-selected')).toBe('false');

    fireEvent.click(artifactsTab);

    expect(artifactsTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByRole('tabpanel').getAttribute('aria-labelledby')).toBe(
      artifactsTab.id,
    );
  });

  it('支持方向键切换侧栏 tab 并使用 roving tabindex', () => {
    render(<ControlledRightPanel />);
    const tasksTab = screen.getByRole('tab', { name: '任务' });
    const artifactsTab = screen.getByRole('tab', { name: '生成物' });

    tasksTab.focus();
    fireEvent.keyDown(tasksTab, { key: 'ArrowRight' });

    expect(artifactsTab.getAttribute('aria-selected')).toBe('true');
    expect(artifactsTab.getAttribute('tabindex')).toBe('0');
    expect(tasksTab.getAttribute('tabindex')).toBe('-1');
    expect(document.activeElement).toBe(artifactsTab);
  });

  it('使用唯一 tab id，并让可点击项目成为真实按钮', () => {
    const onArtifactClick = () => {};
    const { container } = render(
      <>
        <ControlledRightPanel
          initialTab="artifacts"
          previewContent="预览一"
          artifacts={[{ id: 'a1', name: 'one.md', type: 'md', contentAvailable: true }]}
          onArtifactClick={onArtifactClick}
        />
        <ControlledRightPanel
          initialTab="artifacts"
          previewContent="预览二"
          artifacts={[{ id: 'a2', name: 'two.md', type: 'md', contentAvailable: true }]}
          onArtifactClick={onArtifactClick}
        />
      </>,
    );

    const ids = [...container.querySelectorAll('[id]')].map(
      (element) => element.id,
    );
    expect(new Set(ids).size).toBe(ids.length);
    for (const tab of screen.getAllByRole('tab')) {
      expect(tab.getAttribute('aria-controls')).toBeTruthy();
    }
    expect(screen.getAllByRole('button', { name: 'one.md' })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: 'two.md' })).toHaveLength(1);
  });

  it('约束任务进度并提供机器可读状态', () => {
    render(
      <ControlledRightPanel
        tasks={[{
          id: 't1',
          title: '编码访谈',
          status: 'running',
          progress: 250,
        }]}
        onTaskClick={() => {}}
      />,
    );

    const progress = screen.getByRole('progressbar', { name: '编码访谈' });
    expect(progress.getAttribute('aria-valuenow')).toBe('100');
    expect(screen.getByText('执行中')).toBeDefined();
  });

  it('无 previewContent 时不显示预览区', () => {
    const { container } = render(
      <ControlledRightPanel
        initialTab="artifacts"
        artifacts={[{ id: 'a1', name: 'test.md', type: 'md', contentAvailable: false }]}
      />,
    );
    expect(container.querySelector('.artifact-live-preview')).toBeNull();
  });

  it('在生成物读取失败时显示明确错误而不是保留误导性预览', () => {
    render(
      <ControlledRightPanel
        initialTab="artifacts"
        artifactError="无法打开这个生成物，请稍后重试。"
        artifacts={[{ id: 'failed', name: 'failed.md', type: 'md', contentAvailable: true }]}
        onArtifactClick={() => {}}
      />,
    );
    expect(screen.getByRole('alert').textContent).toContain('无法打开这个生成物');
  });

  it('仅允许重新打开已持久化的内容型生成物', () => {
    const onArtifactClick = vi.fn();
    render(
      <ControlledRightPanel
        initialTab="artifacts"
        artifacts={[
          { id: 'inline', name: 'analysis.md', type: 'md', contentAvailable: true },
          { id: 'file', name: 'attachment.pdf', type: 'pdf', contentAvailable: false },
        ]}
        onArtifactClick={onArtifactClick}
      />,
    );

    const inline = screen.getByRole('button', { name: 'analysis.md' });
    const file = screen.getByRole('button', { name: 'attachment.pdf' });
    expect(inline.hasAttribute('disabled')).toBe(false);
    expect(file.hasAttribute('disabled')).toBe(true);
    fireEvent.click(file);
    expect(onArtifactClick).not.toHaveBeenCalled();
    fireEvent.click(inline);
    expect(onArtifactClick).toHaveBeenCalledTimes(1);
    expect(onArtifactClick).toHaveBeenCalledWith(expect.objectContaining({ id: 'inline' }));
  });

  it('严格服从父级 tab 状态而不保留内部兼容状态', () => {
    const onActiveTabChange = vi.fn();
    const { rerender } = render(
      <RightPanel
        activeTab="tasks"
        onActiveTabChange={onActiveTabChange}
        previewContent="测试内容"
      />,
    );
    const artifactsTab = screen.getByRole('tab', { name: '生成物' });

    fireEvent.click(artifactsTab);

    expect(onActiveTabChange).toHaveBeenCalledWith('artifacts');
    expect(artifactsTab.getAttribute('aria-selected')).toBe('false');
    expect(screen.queryByText('测试内容')).toBeNull();

    rerender(
      <RightPanel
        activeTab="artifacts"
        onActiveTabChange={onActiveTabChange}
        previewContent="测试内容"
      />,
    );
    expect(artifactsTab.getAttribute('aria-selected')).toBe('true');
    expect(screen.getByText('测试内容')).toBeDefined();
  });
});
