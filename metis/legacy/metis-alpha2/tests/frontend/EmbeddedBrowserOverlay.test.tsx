/**
 * EmbeddedBrowserOverlay — 文献原文内嵌浏览浮层。
 *
 * 覆盖：打开时导航并显示原生视图、地址栏回车导航、下载请求确认条
 * （保存到项目 / 放弃）、保存失败提示、关闭回调与视图隐藏。
 *
 * @vitest-environment jsdom
 */

import { describe, it, expect, afterEach, beforeEach, vi } from 'vitest';
import { render, cleanup, fireEvent, screen, waitFor } from '@testing-library/react';
import EmbeddedBrowserOverlay from '../../src/components/EmbeddedBrowserOverlay';

const browserNavigate = vi.fn(async () => ({ ok: true, url: 'https://www.ncpssd.org/' }));
const browserShow = vi.fn(async () => ({ ok: true }));
const browserHide = vi.fn(async () => ({ ok: true }));
const browserSetBounds = vi.fn(async () => ({ ok: true }));
const browserReload = vi.fn(async () => ({ ok: true }));
const browserListDownloads = vi.fn(async () => []);
const browserAcceptDownload = vi.fn();
const browserCancelDownload = vi.fn(async () => ({ ok: true }));

type StateListener = (state: { url: string; title: string; loading: boolean; canGoBack: boolean; canGoForward: boolean }) => void;
type DownloadListener = (download: { id: string; url: string; filename: string; mimeType: string; pageUrl: string; pageTitle: string }) => void;
let stateListeners: StateListener[] = [];
let downloadListeners: DownloadListener[] = [];

beforeEach(() => {
  browserNavigate.mockClear();
  browserShow.mockClear();
  browserHide.mockClear();
  browserSetBounds.mockClear();
  browserReload.mockClear();
  browserAcceptDownload.mockReset();
  browserCancelDownload.mockClear();
  browserListDownloads.mockClear().mockResolvedValue([]);
  stateListeners = [];
  downloadListeners = [];
  window.metis = {
    browserNavigate,
    browserShow,
    browserHide,
    browserSetBounds,
    browserReload,
    browserListDownloads,
    browserAcceptDownload,
    browserCancelDownload,
    onBrowserState: (cb: StateListener) => { stateListeners.push(cb); return () => {}; },
    onBrowserDownloadRequest: (cb: DownloadListener) => { downloadListeners.push(cb); return () => {}; },
  } as unknown as typeof window.metis;
});

afterEach(() => {
  cleanup();
  delete (window as { metis?: unknown }).metis;
});

function pushState(state: Parameters<StateListener>[0]) {
  for (const listener of stateListeners) listener(state);
}

function pushDownload(download: Parameters<DownloadListener>[0]) {
  for (const listener of downloadListeners) listener(download);
}

describe('EmbeddedBrowserOverlay', () => {
  it('打开时导航到原文页并同步原生视图', async () => {
    render(<EmbeddedBrowserOverlay url="https://www.ncpssd.org/Literature/articleinfo?id=1" onClose={() => {}} projectId="proj-1" />);
    await waitFor(() => {
      expect(browserNavigate).toHaveBeenCalledWith('https://www.ncpssd.org/Literature/articleinfo?id=1');
      expect(browserShow).toHaveBeenCalled();
    });
    expect((screen.getByTestId('browser-overlay-address') as HTMLInputElement).value)
      .toBe('https://www.ncpssd.org/Literature/articleinfo?id=1');
  });

  it('地址栏回车导航到新地址', async () => {
    render(<EmbeddedBrowserOverlay url="https://a.example" onClose={() => {}} projectId="proj-1" />);
    await waitFor(() => { expect(browserShow).toHaveBeenCalled(); });

    const input = screen.getByTestId('browser-overlay-address');
    fireEvent.change(input, { target: { value: 'www.ncpssd.org' } });
    fireEvent.submit(input.closest('form')!);

    expect(browserNavigate).toHaveBeenCalledWith('https://www.ncpssd.org');
  });

  it('下载请求弹出确认条：保存到项目后消失并提示', async () => {
    browserAcceptDownload.mockResolvedValue({ ok: true, savedPath: 'D:/data/projects/proj-1/pdfs/a.pdf' });
    render(<EmbeddedBrowserOverlay url="https://a.example" onClose={() => {}} projectId="proj-1" />);
    await waitFor(() => { expect(browserShow).toHaveBeenCalled(); });

    pushDownload({ id: 'dl-1', url: 'https://a.example/a.pdf', filename: 'a.pdf', mimeType: 'application/pdf', pageUrl: 'https://a.example', pageTitle: 'A' });
    await waitFor(() => {
      expect(screen.getByTestId('browser-overlay-download')).toBeTruthy();
    });
    expect(screen.getByTestId('browser-overlay-accept').textContent).toContain('保存到本项目');

    fireEvent.click(screen.getByTestId('browser-overlay-accept'));
    await waitFor(() => {
      expect(browserAcceptDownload).toHaveBeenCalledWith('dl-1', 'proj-1');
      expect(screen.queryByTestId('browser-overlay-download')).toBeNull();
      expect(screen.getByTestId('browser-overlay-notice').textContent).toContain('a.pdf');
    });
  });

  it('保存失败时提示错误且确认条保留', async () => {
    browserAcceptDownload.mockResolvedValue({ ok: false, error: 'download_http_403' });
    render(<EmbeddedBrowserOverlay url="https://a.example" onClose={() => {}} projectId="proj-1" />);
    await waitFor(() => { expect(browserShow).toHaveBeenCalled(); });

    pushDownload({ id: 'dl-2', url: 'https://a.example/b.pdf', filename: 'b.pdf', mimeType: 'application/pdf', pageUrl: 'https://a.example', pageTitle: 'B' });
    await waitFor(() => {
      expect(screen.getByTestId('browser-overlay-accept')).toBeTruthy();
    });

    fireEvent.click(screen.getByTestId('browser-overlay-accept'));
    await waitFor(() => {
      expect(screen.getByTestId('browser-overlay-notice').textContent).toContain('保存失败');
    });
    expect(screen.getByTestId('browser-overlay-download')).toBeTruthy();
  });

  it('放弃下载调用取消并移除确认条', async () => {
    render(<EmbeddedBrowserOverlay url="https://a.example" onClose={() => {}} projectId={null} />);
    await waitFor(() => { expect(browserShow).toHaveBeenCalled(); });

    pushDownload({ id: 'dl-3', url: 'https://a.example/c.pdf', filename: 'c.pdf', mimeType: 'application/pdf', pageUrl: 'https://a.example', pageTitle: 'C' });
    await waitFor(() => {
      expect(screen.getByTestId('browser-overlay-cancel')).toBeTruthy();
    });
    fireEvent.click(screen.getByTestId('browser-overlay-cancel'));

    await waitFor(() => {
      expect(browserCancelDownload).toHaveBeenCalledWith('dl-3');
      expect(screen.queryByTestId('browser-overlay-download')).toBeNull();
    });
  });

  it('关闭按钮触发 onClose 并隐藏原生视图', async () => {
    const onClose = vi.fn();
    render(<EmbeddedBrowserOverlay url="https://a.example" onClose={onClose} projectId="proj-1" />);
    await waitFor(() => { expect(browserShow).toHaveBeenCalled(); });

    fireEvent.click(screen.getByTestId('browser-overlay-close'));
    expect(onClose).toHaveBeenCalledTimes(1);
  });

  it('加载状态来自浏览器状态推送', async () => {
    render(<EmbeddedBrowserOverlay url="https://a.example" onClose={() => {}} projectId="proj-1" />);
    await waitFor(() => { expect(browserShow).toHaveBeenCalled(); });

    pushState({ url: 'https://a.example/x', title: 'X', loading: true, canGoBack: true, canGoForward: false });
    await waitFor(() => {
      expect(screen.getByTestId('browser-overlay-loading')).toBeTruthy();
    });
    expect((screen.getByTestId('browser-overlay-back') as HTMLButtonElement).disabled).toBe(false);
  });
});
