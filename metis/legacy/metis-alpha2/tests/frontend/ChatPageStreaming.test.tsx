/**
 * ChatPage streaming experience — model tokens append live to the assistant
 * message, reasoning renders as the thinking process, and the elapsed timer
 * runs until the turn settles (ZCode-style conversational feedback).
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatPage from '../../src/pages/ChatPage';
import type { AgentResponse } from '../../engine/runtime/ChatRuntimeContract';

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeAgentResponse(status: AgentResponse['status'], answer = ''): AgentResponse {
  return { version: 1, turnId: 'turn-1', status, answer, diagnostics: [], citations: [], events: [] };
}

type StreamDispatch = {
  turnId?: string;
  sessionId?: string;
  content: string;
  reasoning?: string;
  isFinished: boolean;
};

function mockMetis(overrides: Record<string, unknown> = {}) {
  const handlers: { stream?: (data: StreamDispatch) => void } = {};
  const metis = {
    listSessions: vi.fn(async () => ({
      success: true,
      sessions: [{ id: 'session-a', createdAt: 1, lastActivity: 1, messageCount: 0, archived: false }],
    })),
    getMessages: vi.fn(async () => []),
    listPersonalization: vi.fn(async () => ({ definitions: [] })),
    listSkills: vi.fn(async () => []),
    getActiveSkill: vi.fn(async () => null),
    setActiveSkill: vi.fn(async () => {}),
    appendMessage: vi.fn(async () => ({ ok: true })),
    listArtifacts: vi.fn(async () => ({ success: true, items: [] })),
    onArtifactCreated: vi.fn(() => () => {}),
    onGoalStepStart: vi.fn(() => () => {}),
    onGoalStepComplete: vi.fn(() => () => {}),
    onGoalStepFailed: vi.fn(() => () => {}),
    onGoalProgress: vi.fn(() => () => {}),
    agentChat: vi.fn(),
    agentControl: vi.fn(),
    onChatStreamChunk: vi.fn((cb: (data: Required<Pick<StreamDispatch, 'turnId' | 'sessionId'>> & Omit<StreamDispatch, 'turnId' | 'sessionId'>) => void) => {
      // Convenience only for existing tests: calls without a turnId model a
      // chunk from the currently issued renderer request. Explicit turnIds
      // remain observable so stale same-session chunks are testable.
      handlers.stream = (data) => {
        const calls = (metis.agentChat as ReturnType<typeof vi.fn>).mock.calls;
        const options = calls[calls.length - 1]?.[3] as { turnId?: unknown } | undefined;
        const turnId = data.turnId ?? options?.turnId;
        if (typeof turnId !== 'string') return;
        cb({ ...data, turnId, sessionId: data.sessionId ?? 'session-a' });
      };
      return () => {};
    }),
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return { metis, handlers };
}

function renderChat() {
  return render(<ChatPage renderLayout={(slots) => <div>{slots.workspace}</div>} uiMode="production" />);
}

async function sendQuestion(text: string, metis: Record<string, unknown>) {
  // The send path is gated on history being ready (session created + history
  // loaded), so wait for the history load to start before clicking send.
  await waitFor(() => expect(metis.getMessages as ReturnType<typeof vi.fn>).toHaveBeenCalled());
  const input = screen.getByPlaceholderText('提出一个研究问题...');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByText('发送'));
}

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView === 'undefined') {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
  (window as unknown as { metis: unknown }).metis = undefined;
});

describe('ChatPage streaming output', () => {
  it('appends streamed tokens live with reasoning and an elapsed timer', async () => {
    const pending = deferred<AgentResponse>();
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());

    await sendQuestion('流式输出测试？', metis);

    // First delta creates the in-flight assistant message with reasoning.
    handlers.stream?.({ sessionId: 'session-a', content: '第一段', reasoning: '先分析', isFinished: false });
    expect(await screen.findByText('第一段')).toBeDefined();
    expect(screen.getByText('先分析')).toBeDefined();
    // The thinking block is open while streaming.
    const details = screen.getByText('思考中…').closest('details');
    expect(details?.open).toBe(true);
    // The running timer is visible.
    expect(screen.getByTestId('message-elapsed').textContent).toMatch(/\d+(\.\d+)?s/u);

    // Later deltas append to the same message.
    handlers.stream?.({ sessionId: 'session-a', content: '第二段', reasoning: '再分析', isFinished: false });
    expect(await screen.findByText('第一段第二段')).toBeDefined();
    expect(screen.getByText('先分析再分析')).toBeDefined();

    // Finish settles the timer.
    handlers.stream?.({ sessionId: 'session-a', content: '', isFinished: true });
    await waitFor(() => {
      expect(screen.getByTestId('message-elapsed').textContent).toMatch(/\d+(\.\d+)?s/u);
    });

    // The authoritative answer replaces the streamed content without
    // creating a second assistant message.
    pending.resolve(makeAgentResponse('completed', '最终完整答案'));
    await waitFor(() => {
      expect(screen.getByText('最终完整答案')).toBeDefined();
    });
    expect(screen.queryByText('第一段第二段')).toBeNull();
    expect(screen.getAllByText('最终完整答案')).toHaveLength(1);
  });

  it('shows the elapsed time on a non-streamed (fallback) answer', async () => {
    const { metis } = mockMetis({ agentChat: vi.fn(async () => makeAgentResponse('completed', '一次性答案')) });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());

    await sendQuestion('非流式场景？', metis);
    expect(await screen.findByText('一次性答案')).toBeDefined();
    expect(screen.getByTestId('message-elapsed').textContent).toMatch(/\d+(\.\d+)?s/u);
  });

  it('ignores stream chunks for a different session', async () => {
    const pending = deferred<AgentResponse>();
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());

    await sendQuestion('会话隔离测试？', metis);

    // A chunk from another session must not render anything.
    handlers.stream?.({ sessionId: 'other-session', content: '不该出现的内容', isFinished: false });
    expect(screen.queryByText('不该出现的内容')).toBeNull();

    pending.resolve(makeAgentResponse('completed', '正常回复'));
    expect(await screen.findByText('正常回复')).toBeDefined();
  });

  it('ignores delayed stream chunks from an older turn in the same session', async () => {
    const pending = deferred<AgentResponse>();
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());

    await sendQuestion('同会话回合隔离测试？', metis);
    const options = (metis.agentChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as { turnId?: string };
    expect(options.turnId).toMatch(/^chat-/);

    handlers.stream?.({
      turnId: 'chat-delayed-previous-request',
      sessionId: 'session-a',
      content: '旧回合的迟到内容',
      isFinished: false,
    });
    expect(screen.queryByText('旧回合的迟到内容')).toBeNull();

    pending.resolve(makeAgentResponse('completed', '当前回合正常回复'));
    expect(await screen.findByText('当前回合正常回复')).toBeDefined();
  });
});

describe('ChatPage message actions and input toolbar', () => {
  it('copies a message from the per-message action row', async () => {
    const writeText = vi.fn().mockResolvedValue(undefined);
    Object.defineProperty(navigator, 'clipboard', {
      configurable: true,
      value: { writeText },
    });
    const pending = deferred<AgentResponse>();
    const { metis } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    await sendQuestion('复制按钮测试？', metis);

    pending.resolve(makeAgentResponse('completed', '要复制的内容'));
    await waitFor(() => expect(screen.getAllByTestId('copy-message').length).toBeGreaterThanOrEqual(2));
    const copyButtons = screen.getAllByTestId('copy-message');
    fireEvent.click(copyButtons[copyButtons.length - 1]!);
    await waitFor(() => {
      expect(writeText).toHaveBeenCalledWith('要复制的内容');
    });
  });

  it('does not show a learn-skill action (removed per 2026-09 spec)', async () => {
    const { metis } = mockMetis({ generateSkillFromConversation: vi.fn() });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());

    expect(screen.queryByTestId('learn-conversation-skill')).toBeNull();
  });
});

describe('ChatPage session auto-naming', () => {
  it('titles a fresh session from the first user message', async () => {
    const pending = deferred<AgentResponse>();
    const updateSession = vi.fn().mockResolvedValue({ success: true, code: 'updated' });
    const { metis } = mockMetis({
      agentChat: vi.fn(() => pending.promise),
      updateSession,
    });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    await sendQuestion('自动命名的第一条消息', metis);

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith('session-a', { title: '自动命名的第一条消息' });
    });
    pending.resolve(makeAgentResponse('completed', '回复'));
  });

  it('does not overwrite a custom session title', async () => {
    const pending = deferred<AgentResponse>();
    const updateSession = vi.fn().mockResolvedValue({ success: true, code: 'updated' });
    const { metis } = mockMetis({
      agentChat: vi.fn(() => pending.promise),
      updateSession,
      listSessions: vi.fn(async () => ({
        success: true,
        sessions: [{ id: 'session-a', title: '我的研究会话', createdAt: 1, lastActivity: 1, messageCount: 0, archived: false }],
      })),
    });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    await sendQuestion('不应覆盖已有标题', metis);

    pending.resolve(makeAgentResponse('completed', '回复'));
    expect(updateSession).not.toHaveBeenCalled();
  });
});

describe('ChatPage auto-name button', () => {
  it('names the conversation from its first user message via the composer button', async () => {
    const pending = deferred<AgentResponse>();
    const updateSession = vi.fn().mockResolvedValue({ success: true, code: 'updated' });
    const { metis } = mockMetis({
      agentChat: vi.fn(() => pending.promise),
      updateSession,
    });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    await sendQuestion('命名按钮测试的消息', metis);

    const nameButton = await screen.findByTestId('auto-name-session');
    expect(nameButton.closest('.chat-input-area')).toBeTruthy();
    fireEvent.click(nameButton);

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith('session-a', { title: '命名按钮测试的消息' });
    });
    pending.resolve(makeAgentResponse('completed', '回复'));
  });

  it('falls back to the longest user message for short openers', async () => {
    const pending = deferred<AgentResponse>();
    const updateSession = vi.fn().mockResolvedValue({ success: true, code: 'updated' });
    const { metis } = mockMetis({
      agentChat: vi.fn(() => pending.promise),
      updateSession,
    });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    await sendQuestion('好', metis);
    pending.resolve(makeAgentResponse('completed', '第一条回复'));
    await screen.findByText('第一条回复');
    await sendQuestion('这是一条非常长的用于兜底命名的用户消息内容', metis);

    fireEvent.click(await screen.findByTestId('auto-name-session'));

    await waitFor(() => {
      expect(updateSession).toHaveBeenCalledWith('session-a', { title: '这是一条非常长的用于兜底命名的用户消息内容' });
    });
    pending.resolve(makeAgentResponse('completed', '回复'));
  });
});
