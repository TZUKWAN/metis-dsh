/**
 * 选题页会话 tab 化 + 会话管理(2026-09 刘总:tab 替代左栏列表;分类/重命名/删除)。
 *
 * 契约:
 *   1. 会话渲染为顶部 tab 条,按分类分组(无分类归入「未分类」),归档会话不显示;
 *   2. tab 上的 × 关闭 = 删除,必须先 window.confirm;
 *   3. 会话栏的分类下拉/重命名通过 topicUpdateSession patch 持久化;
 *   4. 新建面板可直接选择/新建分类,随 topicCreateSession 一并提交。
 *
 * @vitest-environment jsdom
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import TopicWorkspacePage from '../../src/pages/TopicWorkspacePage';

type SessionRow = { id: string; title: string; status: string; category?: string | null };

const SESSIONS: SessionRow[] = [
  { id: 's1', title: '劳动社会学选题', status: 'exploring', category: '劳动研究' },
  { id: 's2', title: '平台经济选题', status: 'comparing', category: '劳动研究' },
  { id: 's3', title: '教育技术选题', status: 'exploring', category: null },
  { id: 's4', title: '已归档选题', status: 'archived', category: null },
];

afterEach(() => {
  cleanup();
  (window as unknown as { metis: unknown }).metis = undefined;
  vi.restoreAllMocks();
});

function makeMetis(sessions: SessionRow[]) {
  const metis = {
    topicListSessions: vi.fn(async () => sessions),
    topicGetSession: vi.fn(async (id: string) => ({
      session: sessions.find((row) => row.id === id) ?? { id, title: id, status: 'exploring', category: null },
      candidates: [],
      messages: [],
    })),
    topicCreateSession: vi.fn(async () => ({ ok: true, session: { id: 's-new', title: '新选题', status: 'exploring', category: null } })),
    topicChat: vi.fn(async () => ({ ok: false, code: 'agent_unavailable' })),
    topicUpdateSession: vi.fn(async () => ({})),
    topicDeleteSession: vi.fn(async () => true),
    externalRefList: vi.fn(async () => ({ ok: true, references: [] })),
    onTopicStreamChunk: vi.fn(() => () => {}),
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

describe('Topic workspace 会话 tab 条(分类分组 + 管理操作)', () => {
  it('renders sessions as tabs grouped by category; archived sessions are hidden', async () => {
    makeMetis(SESSIONS);
    render(<TopicWorkspacePage />);
    expect(await screen.findByTestId('topic-session-s1')).toBeTruthy();
    expect(screen.getByTestId('topic-session-s2')).toBeTruthy();
    expect(screen.getByTestId('topic-session-s3')).toBeTruthy();
    // 分组标签:命名分类 + 未分类;归档会话不进 tab 条。
    expect(screen.getByText('劳动研究')).toBeTruthy();
    expect(screen.getByText('未分类')).toBeTruthy();
    expect(screen.queryByTestId('topic-session-s4')).toBeNull();
  });

  it('tab close deletes the session only after confirmation', async () => {
    const metis = makeMetis(SESSIONS);
    const confirmSpy = vi.spyOn(window, 'confirm').mockReturnValue(false);
    render(<TopicWorkspacePage />);
    const tab = await screen.findByTestId('topic-session-s3');
    fireEvent.click(tab.parentElement!.querySelector('.topic-workspace__tab-close')!);
    expect(confirmSpy).toHaveBeenCalled();
    expect(metis.topicDeleteSession).not.toHaveBeenCalled();

    confirmSpy.mockReturnValue(true);
    fireEvent.click(tab.parentElement!.querySelector('.topic-workspace__tab-close')!);
    await waitFor(() => expect(metis.topicDeleteSession).toHaveBeenCalledWith('s3'));
  });

  it('setting a category on the active session patches via topicUpdateSession', async () => {
    const metis = makeMetis(SESSIONS);
    render(<TopicWorkspacePage />);
    fireEvent.click(await screen.findByTestId('topic-session-s3'));
    fireEvent.change(await screen.findByTestId('topic-session-category'), { target: { value: '劳动研究' } });
    await waitFor(() => expect(metis.topicUpdateSession).toHaveBeenCalledWith({ sessionId: 's3', patch: { category: '劳动研究' } }));
  });

  it('rename patches the session title', async () => {
    const metis = makeMetis(SESSIONS);
    render(<TopicWorkspacePage />);
    fireEvent.click(await screen.findByTestId('topic-session-s1'));
    fireEvent.click(await screen.findByTestId('topic-session-rename'));
    const input = await screen.findByTestId('topic-session-rename-input');
    fireEvent.change(input, { target: { value: '新标题' } });
    fireEvent.keyDown(input, { key: 'Enter' });
    await waitFor(() => expect(metis.topicUpdateSession).toHaveBeenCalledWith({ sessionId: 's1', patch: { title: '新标题' } }));
  });

  it('new-topic panel can create a session directly into a new category', async () => {
    const metis = makeMetis(SESSIONS);
    render(<TopicWorkspacePage />);
    fireEvent.click(await screen.findByTestId('topic-new'));
    fireEvent.change(await screen.findByTestId('topic-new-intent'), { target: { value: '想研究零工经济' } });
    fireEvent.change(await screen.findByTestId('topic-new-category'), { target: { value: '__new__' } });
    fireEvent.change(await screen.findByTestId('topic-new-category-custom'), { target: { value: '零工经济' } });
    fireEvent.click(screen.getByTestId('topic-create-submit'));
    await waitFor(() => expect(metis.topicCreateSession).toHaveBeenCalledWith({ initialIntent: '想研究零工经济', category: '零工经济' }));
  });
});
