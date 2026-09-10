// @vitest-environment jsdom
/**
 * UX-CHAT-002 — 失败/中断/取消时清理空白流式消息。
 *
 * 覆盖 error、max_turns_reached、interrupted、cancelled 四种非成功结算：
 * 1) 已有部分内容的流式占位被标记为「未完成草稿」并停止流式；
 * 2) 空内容占位被删除，不残留空白 M 气泡；
 * 3) 每种状态只出现一条明确收据，无重复错误。
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatPage from '../../src/pages/ChatPage';
import type { AgentResponse } from '../../engine/runtime/ChatRuntimeContract';

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (reason?: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => {
    resolve = resolvePromise;
    reject = rejectPromise;
  });
  return { promise, resolve, reject };
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
  const handlers: {
    stream?: (data: StreamDispatch) => void;
    execution?: (data: { turnId: string; event: AgentResponse['events'][number] }) => void;
  } = {};
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
      handlers.stream = (data) => {
        const calls = (metis.agentChat as ReturnType<typeof vi.fn>).mock.calls;
        const options = calls[calls.length - 1]?.[3] as { turnId?: unknown } | undefined;
        const turnId = data.turnId ?? options?.turnId;
        if (typeof turnId !== 'string') return;
        cb({ ...data, turnId, sessionId: data.sessionId ?? 'session-a' });
      };
      return () => {};
    }),
    onAgentExecutionEvent: vi.fn((cb: (data: { turnId: string; event: AgentResponse['events'][number] }) => void) => {
      handlers.execution = cb;
      return () => {};
    }),
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return { metis, handlers };
}

function renderChat() {
  // 侧栏（leftPanel）也渲染，便于断言会话摘要（UX-CHAT-004）。
  return render(<ChatPage renderLayout={(slots) => <div>{slots.leftPanel}{slots.workspace}</div>} uiMode="production" />);
}

async function sendQuestion(text: string, metis: Record<string, unknown>) {
  await waitFor(() => expect(metis.getMessages as ReturnType<typeof vi.fn>).toHaveBeenCalled());
  const input = screen.getByPlaceholderText('提出一个研究问题...');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByText('发送'));
}

function assistantBubbles(): HTMLElement[] {
  return [...document.querySelectorAll('.chat-message.assistant')] as HTMLElement[];
}

function blankAssistantBubbles(): HTMLElement[] {
  return assistantBubbles().filter((element) => (element.textContent ?? '').trim() === '');
}

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView === 'undefined') {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  (window as unknown as { metis: unknown }).metis = undefined;
});

describe('UX-CHAT-002: non-success turns never leave a blank streaming bubble', () => {
  it.each(['error', 'max_turns_reached'] as const)(
    'settles a partial streaming message as an incomplete draft and shows one receipt (%s)',
    async (status) => {
      const pending = deferred<AgentResponse>();
      const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
      renderChat();
      await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
      await sendQuestion('会失败的问题', metis);

      // 模型开始流式输出部分内容，然后回合以非成功状态结算。
      handlers.stream?.({ sessionId: 'session-a', content: '已生成的部分草稿', isFinished: false });
      expect(await screen.findByText('已生成的部分草稿')).toBeDefined();

      pending.resolve(makeAgentResponse(status));

      // 部分内容被保留并标记为「未完成草稿」。
      await waitFor(() => {
        expect(screen.getByTestId('incomplete-draft')).toBeDefined();
      });
      expect(screen.getByText('已生成的部分草稿')).toBeDefined();
      // 只有一条收据，没有重复错误。
      const receipts = assistantBubbles().filter((element) => (element.textContent ?? '').includes('未能完成'));
      expect(receipts).toHaveLength(1);
      // 没有空白气泡。
      expect(blankAssistantBubbles()).toHaveLength(0);
    },
  );

  it.each(['interrupted', 'cancelled'] as const)(
    'keeps partial content as a draft and shows the interrupt receipt (%s)',
    async (status) => {
      const pending = deferred<AgentResponse>();
      const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
      renderChat();
      await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
      await sendQuestion('需要中断的问题', metis);

      handlers.stream?.({ sessionId: 'session-a', content: '中断前的草稿内容', isFinished: false });
      expect(await screen.findByText('中断前的草稿内容')).toBeDefined();

      pending.resolve(makeAgentResponse(status));

      await waitFor(() => {
        expect(screen.getByText(/任务已中断/)).toBeDefined();
      });
      expect(screen.getByTestId('incomplete-draft')).toBeDefined();
      expect(screen.getByText('中断前的草稿内容')).toBeDefined();
      expect(blankAssistantBubbles()).toHaveLength(0);
      // 只有一条中断收据。
      expect(screen.getAllByText(/任务已中断/)).toHaveLength(1);
    },
  );

  it.each(['error', 'max_turns_reached', 'interrupted', 'cancelled'] as const)(
    'removes an empty streaming placeholder and leaves exactly one receipt (%s)',
    async (status) => {
      const pending = deferred<AgentResponse>();
      const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
      renderChat();
      await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
      await sendQuestion('空流式的问题', metis);
      await waitFor(() => expect(metis.agentChat).toHaveBeenCalled());

      // 模拟旧缺陷：首个结束流事件携带空内容（例如工具调用回合无文本输出）。
      handlers.stream?.({ sessionId: 'session-a', content: '', isFinished: true });

      pending.resolve(makeAgentResponse(status));

      await waitFor(() => {
        // error/max_turns → 错误收据；interrupted/cancelled → 中断收据。
        const hasErrorReceipt = screen.queryByText(/未能完成/u) !== null;
        const hasInterruptReceipt = screen.queryByText(/任务已中断/u) !== null;
        expect(hasErrorReceipt || hasInterruptReceipt).toBe(true);
      }, { timeout: 4000 });
      // 空占位不得残留；任何空白助手气泡都不允许。
      expect(blankAssistantBubbles()).toHaveLength(0);
    },
  );

  it('does not create a placeholder for an empty first stream event on success', async () => {
    const pending = deferred<AgentResponse>();
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    await sendQuestion('无流式内容的成功回合', metis);

    // 首个事件为空内容 + isFinished（工具回合后直接给出最终回答的场景）。
    handlers.stream?.({ sessionId: 'session-a', content: '', isFinished: true });

    pending.resolve(makeAgentResponse('completed', '最终完整答案'));

    expect(await screen.findByText('最终完整答案')).toBeDefined();
    // 答案只渲染一次，没有多余的空占位气泡。
    expect(screen.getAllByText('最终完整答案')).toHaveLength(1);
    expect(blankAssistantBubbles()).toHaveLength(0);
  });

  it('does not settle a current streaming draft from a delayed older turn in the same session', async () => {
    const pending = deferred<AgentResponse>();
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    await sendQuestion('同会话延迟流不要结算当前草稿', metis);

    const options = (metis.agentChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as { turnId?: string };
    handlers.stream?.({
      turnId: 'chat-stale-turn',
      sessionId: 'session-a',
      content: '过期流内容',
      isFinished: true,
    });
    expect(screen.queryByText('过期流内容')).toBeNull();

    handlers.stream?.({ sessionId: 'session-a', content: '当前草稿', isFinished: false });
    expect(await screen.findByText('当前草稿')).toBeDefined();

    pending.resolve({ ...makeAgentResponse('completed', '当前回合结果'), turnId: options.turnId! });
    expect(await screen.findByText('当前回合结果')).toBeDefined();
    expect(screen.queryByText('过期流内容')).toBeNull();
  });

  it.each(['cancelled', 'error'] as const)(
    'settles a streamed regenerate as a draft rather than leaving it running (%s)',
    async (status) => {
      const pending = deferred<AgentResponse>();
      const { metis, handlers } = mockMetis({
        getMessages: vi.fn(async () => [
          { role: 'user', content: '原始研究问题' },
          { role: 'assistant', content: '旧回答' },
        ]),
        agentChat: vi.fn(() => pending.promise),
      });
      renderChat();
      await screen.findByText('旧回答');
      fireEvent.click(screen.getByTitle('重新生成'));
      await waitFor(() => expect(metis.agentChat).toHaveBeenCalled());

      handlers.stream?.({ sessionId: 'session-a', content: '重新生成中的草稿', isFinished: false });
      expect(await screen.findByText('重新生成中的草稿')).toBeDefined();
      pending.resolve(makeAgentResponse(status));

      await waitFor(() => expect(screen.getByTestId('incomplete-draft')).toBeDefined());
      expect(screen.getByText('重新生成中的草稿')).toBeDefined();
      if (status === 'cancelled') {
        expect(screen.getByText(/任务已中断/)).toBeDefined();
      } else {
        expect(screen.getByText(/未能完成/)).toBeDefined();
      }
    },
  );

  it('settles already-rendered live events onto an error draft when the send promise rejects', async () => {
    const pending = deferred<AgentResponse>();
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    renderChat();
    await sendQuestion('会抛出异常的研究任务', metis);
    await waitFor(() => expect(metis.agentChat).toHaveBeenCalled());
    const options = (metis.agentChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as { turnId?: string };
    handlers.execution?.({
      turnId: options.turnId!,
      event: { type: 'lifecycle', phase: 'started', timestamp: 10, summary: '已真实启动研究任务' },
    });
    handlers.stream?.({ sessionId: 'session-a', content: '异常前的草稿', isFinished: false });
    expect(await screen.findByText('异常前的草稿')).toBeDefined();

    pending.reject(new Error('provider unavailable'));

    await waitFor(() => expect(screen.getByTestId('incomplete-draft')).toBeDefined());
    const timeline = screen.getByTestId('agent-activity-timeline');
    expect(timeline.textContent).toContain('执行失败');
    expect(timeline.textContent).toContain('已真实启动研究任务');
  });
});

describe('UX-CHAT-004: session summaries refresh after a turn', () => {
  it('re-fetches the authoritative session list after the turn settles', async () => {
    const pending = deferred<AgentResponse>();
    const listSessions = vi.fn()
      .mockResolvedValueOnce({
        success: true,
        sessions: [{ id: 'session-a', createdAt: 1, lastActivity: 1, messageCount: 0, archived: false }],
      })
      .mockResolvedValueOnce({
        success: true,
        sessions: [{ id: 'session-a', createdAt: 1, lastActivity: Date.now(), messageCount: 2, archived: false }],
      });
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise), listSessions });
    renderChat();
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    await sendQuestion('会话计数测试', metis);

    handlers.stream?.({ sessionId: 'session-a', content: '回答内容', isFinished: false });
    pending.resolve(makeAgentResponse('completed', '回答内容'));
    await screen.findByText('回答内容');

    // 回合结算后应再次拉取权威会话摘要。
    await waitFor(() => {
      expect(listSessions.mock.calls.length).toBeGreaterThanOrEqual(2);
    }, { timeout: 4000 });
    // 侧栏计数从持久层摘要刷新（0 条 → 2 条），而不是停留在挂载时快照。
    await waitFor(() => {
      expect(screen.getByText(/2\s*条消息/u)).toBeDefined();
    }, { timeout: 4000 });
    expect(screen.queryByText(/0\s*条消息/u)).toBeNull();
  });
});
