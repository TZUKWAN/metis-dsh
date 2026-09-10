/**
 * ProjectMaterialsPanel — 项目参考材料库。
 *
 * 覆盖：说明文字与格式行渲染、列表/九宫格视图切换、空态提示。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import { ProjectMaterialsPanel } from '../../src/pages/ProjectMaterialsPanel';

const projectMaterialList = vi.fn();

function makeMaterial(overrides?: Record<string, unknown>) {
  return {
    id: 'mat-1',
    name: '访谈记录-第一轮.txt',
    category: 'notes',
    charCount: 12345,
    addedAt: 1786342336497,
    ...overrides,
  };
}

describe('ProjectMaterialsPanel', () => {
  beforeEach(() => {
    projectMaterialList.mockReset();
    projectMaterialList.mockResolvedValue({
      ok: true,
      materials: [
        makeMaterial(),
        makeMaterial({ id: 'mat-2', name: '问卷数据.csv', category: 'data' }),
      ],
    });
    window.metis = { projectMaterialList } as unknown as typeof window.metis;
  });

  afterEach(() => {
    cleanup();
    delete (window as { metis?: unknown }).metis;
  });

  it('渲染说明文字与收成一行的格式列表', async () => {
    render(<ProjectMaterialsPanel projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByText('访谈记录-第一轮.txt')).toBeTruthy();
    });
    const formats = document.querySelector('.project-materials__formats');
    expect(formats).toBeTruthy();
    expect(formats!.textContent).toContain('txt / md / csv');
  });

  it('默认列表展示，可切换为九宫格卡片展示', async () => {
    render(<ProjectMaterialsPanel projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByText('访谈记录-第一轮.txt')).toBeTruthy();
    });
    expect(document.querySelector('.project-materials__list')).toBeTruthy();
    expect(screen.queryByTestId('materials-grid')).toBeNull();

    fireEvent.click(screen.getByTestId('materials-view-grid'));
    expect(screen.getByTestId('materials-grid')).toBeTruthy();
    expect(document.querySelector('.project-materials__list')).toBeNull();
    // 卡片内保留改名分类与删除入口
    expect(screen.getByLabelText('修改 访谈记录-第一轮.txt 的分类')).toBeTruthy();
    expect(screen.getByLabelText('删除 问卷数据.csv')).toBeTruthy();

    fireEvent.click(screen.getByTestId('materials-view-list'));
    expect(document.querySelector('.project-materials__list')).toBeTruthy();
  });

  it('没有材料时显示空态引导', async () => {
    projectMaterialList.mockResolvedValue({ ok: true, materials: [] });
    render(<ProjectMaterialsPanel projectId="proj-1" />);
    await waitFor(() => {
      expect(screen.getByText(/还没有材料/)).toBeTruthy();
    });
  });
});
