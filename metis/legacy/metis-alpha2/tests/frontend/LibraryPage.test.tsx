/**
 * LibraryPage — 我的文献管理（资料页定位：项目/对话的资料管理库）。
 *
 * 手动检索区已移除（检索由 AI 对话/自主科研路径调用），本文件覆盖：
 * 无 PDF 条目的题录详情、编辑保存、收藏、删除、搜索过滤与阅读入口、
 * 「打开原文」经 window.metis.openExternal 打开与无链接提示、标签展示中文化。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, waitFor, screen } from '@testing-library/react';
import LibraryPage from '../../src/pages/LibraryPage';
import { useMetisStore } from '../../src/store';
import type { PaperItem } from '../../engine/research/PaperItem';
import { researchWorkspaceStore } from '../../src/research/researchWorkspaceStore';

function makePaper(overrides?: Partial<PaperItem>): PaperItem {
  return {
    id: 'paper-existing-1',
    title: '已采集的知网文献',
    authors: [],
    year: 0,
    venue: '',
    abstract: '网页采集的摘要',
    pdfUrl: 'https://kns.cnki.net/example',
    tags: ['collected'],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    referenceIds: [],
    addedAt: 1786342336497,
    ...overrides,
  };
}

const savePaper = vi.fn(async () => true);
const deletePaper = vi.fn(async () => true);
const linkPaperToProject = vi.fn(async () => ({ ok: true }));
const openExternal = vi.fn(async () => ({ success: true }));

function libraryMetisMock() {
  return {
    savePaper, deletePaper, linkPaperToProject, openExternal,
  } as unknown as typeof window.metis;
}

function seedPapers(papers: PaperItem[]) {
  useMetisStore.setState({ papers });
}

function resetStore() {
  useMetisStore.setState({
    papers: [],
    paperFilter: { query: '' },
    notes: [],
    selectedNote: null,
    experiments: [],
    collections: [],
    selectedCollection: null,
    workflowRuns: [],
    selectedPaperId: null,
    locale: 'zh',
    theme: 'light',
    isHydrated: true,
  });
  researchWorkspaceStore.setState({ activeProjectId: null });
}

describe('LibraryPage — 我的文献', () => {
  beforeEach(() => {
    resetStore();
    savePaper.mockClear();
    deletePaper.mockClear();
    linkPaperToProject.mockClear();
    openExternal.mockClear();
    window.metis = libraryMetisMock();
    seedPapers([
      makePaper(),
      makePaper({
        id: 'paper-existing-2',
        title: 'Multiple intermediate phases in the Aubry-André model',
        authors: ['Guo, Chenyue'],
        year: 2024,
        venue: 'Physical Review B',
        doi: '10.1103/PhysRevB.109.174203',
        pdfUrl: 'https://arxiv.org/abs/2401.17000',
        tags: ['collected', '物理'],
        readStatus: 'reading',
        rating: 4,
        starred: true,
        addedAt: 1786347983187,
      }),
    ]);
  });

  afterEach(() => {
    cleanup();
    delete (window as { metis?: unknown }).metis;
  });

  it('渲染工具条与文献列表，无 PDF 条目不再是禁用按钮', () => {
    render(<LibraryPage />);
    expect(screen.getByTestId('library-toolbar')).toBeTruthy();
    expect(screen.getByTestId('library-filter-input')).toBeTruthy();
    expect(screen.getByTestId('library-sort-select')).toBeTruthy();
    expect(screen.getByTestId('library-status-select')).toBeTruthy();
    const items = screen.getAllByTestId('library-paper-item');
    expect(items).toHaveLength(2);
    for (const open of screen.getAllByTestId('library-paper-open')) {
      expect((open as HTMLButtonElement).disabled).toBe(false);
    }
    // 无本地 PDF 的条目不显示阅读按钮，但仍可打开原文链接。
    const readButtons = screen.queryAllByTestId('library-paper-read');
    expect(readButtons).toHaveLength(0);
    expect(screen.getAllByTestId('library-paper-source')).toHaveLength(2);
  });

  it('不再渲染手动检索区（检索由 AI 路径调用）', () => {
    render(<LibraryPage />);
    expect(screen.queryByTestId('library-search-input')).toBeNull();
    expect(screen.queryByTestId('library-search-submit')).toBeNull();
  });

  it('点击无 PDF 条目打开题录详情并展示全部字段', async () => {
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /已采集的知网文献/ }));

    await waitFor(() => {
      expect(screen.getByTestId('library-detail')).toBeTruthy();
    });
    expect(screen.getByTestId('library-detail').textContent).toContain('已采集的知网文献');
    expect(screen.getByTestId('library-detail').textContent).toContain('未知作者');
    expect(screen.getByTestId('library-detail').textContent).toContain('网页采集的摘要');
    expect(screen.getByTestId('library-detail-edit')).toBeTruthy();
    expect(screen.getByTestId('library-detail-source')).toBeTruthy();
    expect(screen.getByTestId('library-detail-star')).toBeTruthy();
    expect(screen.getByTestId('library-detail-delete')).toBeTruthy();
    expect(screen.queryByTestId('library-detail-read')).toBeNull();
  });

  it('编辑题录并保存后列表立即反映修改', async () => {
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /已采集的知网文献/ }));
    await waitFor(() => {
      expect(screen.getByTestId('library-detail-edit')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('library-detail-edit'));
    await waitFor(() => {
      expect(screen.getByTestId('library-edit-form')).toBeTruthy();
    });

    fireEvent.change(screen.getByTestId('library-edit-title'), { target: { value: '修正后的文献标题' } });
    fireEvent.change(screen.getByTestId('library-edit-authors'), { target: { value: '王五；赵六' } });
    fireEvent.change(screen.getByTestId('library-edit-year'), { target: { value: '2023' } });
    fireEvent.change(screen.getByTestId('library-edit-venue'), { target: { value: '社会学研究' } });
    fireEvent.change(screen.getByTestId('library-edit-status'), { target: { value: 'read' } });
    fireEvent.click(screen.getByTestId('library-edit-save'));

    await waitFor(() => {
      expect(screen.getAllByText('修正后的文献标题').length).toBeGreaterThanOrEqual(1);
    });
    const updated = useMetisStore.getState().papers.find((p) => p.id === 'paper-existing-1')!;
    expect(updated.authors).toEqual(['王五', '赵六']);
    expect(updated.year).toBe(2023);
    expect(updated.venue).toBe('社会学研究');
    expect(updated.readStatus).toBe('read');
    expect(savePaper).toHaveBeenCalled();
  });

  it('删除需要二次确认且确认后从列表移除', async () => {
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /已采集的知网文献/ }));
    await waitFor(() => {
      expect(screen.getByTestId('library-detail-delete')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('library-detail-delete'));
    await waitFor(() => {
      expect(screen.getByTestId('library-delete-confirm')).toBeTruthy();
    });
    expect(screen.queryAllByTestId('library-paper-item')).toHaveLength(2);

    fireEvent.click(screen.getByTestId('library-delete-confirm'));
    await waitFor(() => {
      expect(screen.queryAllByTestId('library-paper-item')).toHaveLength(1);
    });
    expect(deletePaper).toHaveBeenCalledWith('paper-existing-1');
  });

  it('搜索过滤按标题/作者/期刊匹配', async () => {
    render(<LibraryPage />);
    expect(screen.getAllByTestId('library-paper-item')).toHaveLength(2);

    fireEvent.change(screen.getByTestId('library-filter-input'), { target: { value: 'Aubry' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('library-paper-item')).toHaveLength(1);
    });
    expect(screen.getByText(/Aubry-André/)).toBeTruthy();

    fireEvent.change(screen.getByTestId('library-filter-input'), { target: { value: '不存在的关键词' } });
    await waitFor(() => {
      expect(screen.getByTestId('library-empty')).toBeTruthy();
    });
  });

  it('阅读状态筛选只显示对应条目', async () => {
    render(<LibraryPage />);
    fireEvent.change(screen.getByTestId('library-status-select'), { target: { value: 'reading' } });
    await waitFor(() => {
      expect(screen.getAllByTestId('library-paper-item')).toHaveLength(1);
    });
    expect(screen.getByText(/intermediate phases/)).toBeTruthy();
  });

  it('收藏在详情中切换并同步到列表星标', async () => {
    render(<LibraryPage />);
    fireEvent.click(screen.getByRole('button', { name: /已采集的知网文献/ }));
    await waitFor(() => {
      expect(screen.getByTestId('library-detail-star')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('library-detail-star'));
    await waitFor(() => {
      const paper = useMetisStore.getState().papers.find((p) => p.id === 'paper-existing-1')!;
      expect(paper.starred).toBe(true);
    });
  });

  it('内部英文标签 scenario-imported 展示为中文「场景导入」', () => {
    seedPapers([makePaper({ id: 'paper-tag-1', title: '场景导入的文献', tags: ['collected', 'scenario-imported'] })]);
    render(<LibraryPage />);
    expect(screen.getByText('场景导入')).toBeTruthy();
    expect(screen.queryByText('scenario-imported')).toBeNull();
  });

  it('打开原文经 openExternal 打开来源链接', async () => {
    render(<LibraryPage />);
    // 列表按添加时间倒序：第二篇是「已采集的知网文献」（pdfUrl 为知网链接）。
    fireEvent.click(screen.getAllByTestId('library-paper-source')[1]!);
    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith('https://kns.cnki.net/example');
    });
  });

  it('没有链接的文献点击「打开原文」如实提示', async () => {
    seedPapers([makePaper({ id: 'paper-nolink', title: '无链接文献', pdfUrl: undefined })]);
    render(<LibraryPage />);
    fireEvent.click(screen.getByTestId('library-paper-source'));
    await waitFor(() => {
      expect(screen.getByTestId('library-source-notice').textContent).toContain('该文献没有可打开的原文链接');
    });
    expect(openExternal).not.toHaveBeenCalled();
  });
});

describe('LibraryPage — 项目资料模式', () => {
  beforeEach(() => {
    resetStore();
    savePaper.mockClear();
    linkPaperToProject.mockClear();
    openExternal.mockClear();
    window.metis = libraryMetisMock();
    seedPapers([
      makePaper({ id: 'paper-proj-1', title: '属于项目的文献', projectId: 'proj-9' }),
      makePaper({ id: 'paper-other', title: '其他项目的文献', projectId: 'proj-8' }),
      makePaper({ id: 'paper-global', title: '未关联的文献' }),
    ]);
  });

  afterEach(() => {
    cleanup();
    delete (window as { metis?: unknown }).metis;
  });

  it('只显示关联到当前项目的文献', () => {
    render(<LibraryPage projectId="proj-9" />);
    const items = screen.getAllByTestId('library-paper-item');
    expect(items).toHaveLength(1);
    expect(screen.getByText('属于项目的文献')).toBeTruthy();
    expect(screen.queryByText('其他项目的文献')).toBeNull();
    expect(screen.queryByText('未关联的文献')).toBeNull();
  });

  it('项目无文献时显示项目引导空态', () => {
    render(<LibraryPage projectId="proj-empty" />);
    expect(screen.getByTestId('library-empty').textContent).toContain('这个项目还没有文献');
  });

  it('项目模式下打开原文同样经 openExternal', async () => {
    render(<LibraryPage projectId="proj-9" />);
    fireEvent.click(screen.getByTestId('library-paper-source'));
    await waitFor(() => {
      expect(openExternal).toHaveBeenCalledWith('https://kns.cnki.net/example');
    });
  });
});
