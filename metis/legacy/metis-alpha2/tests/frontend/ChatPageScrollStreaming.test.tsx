/**
 * ChatPage scroll-follow and stream batching regression coverage.
 *
 * @vitest-environment jsdom
 */

import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
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
  await waitFor(() => expect(metis.getMessages as ReturnType<typeof vi.fn>).toHaveBeenCalled());
  const input = screen.getByPlaceholderText('提出一个研究问题...');
  fireEvent.change(input, { target: { value: text } });
  fireEvent.click(screen.getByText('发送'));
}

type RafHarness = {
  pending: Map<number, FrameRequestCallback>;
  request: ReturnType<typeof vi.fn>;
  flushOne: () => void;
  flushAll: () => void;
  clear: () => void;
};

function installRafHarness(): RafHarness {
  let nextId = 1;
  const pending = new Map<number, FrameRequestCallback>();
  const request = vi.fn((callback: FrameRequestCallback) => {
    const id = nextId;
    nextId += 1;
    pending.set(id, callback);
    return id;
  });
  const cancel = vi.fn((id: number) => { pending.delete(id); });
  Object.defineProperty(window, 'requestAnimationFrame', { configurable: true, value: request });
  Object.defineProperty(window, 'cancelAnimationFrame', { configurable: true, value: cancel });
  const flushOne = () => {
    const entry = pending.entries().next().value as [number, FrameRequestCallback] | undefined;
    if (!entry) return;
    pending.delete(entry[0]);
    entry[1](performance.now());
  };
  const flushAll = () => {
    let guard = 0;
    while (pending.size > 0 && guard < 20) {
      flushOne();
      guard += 1;
    }
  };
  return { pending, request, flushOne, flushAll, clear: () => pending.clear() };
}

function setScrollGeometry(container: HTMLElement, scrollTop: number) {
  Object.defineProperties(container, {
    scrollHeight: { configurable: true, value: 1000 },
    clientHeight: { configurable: true, value: 400 },
    scrollTop: { configurable: true, writable: true, value: scrollTop },
  });
}

describe('ChatPage scroll-follow and stream batching', () => {
  let raf: RafHarness;
  let scrollIntoView: ReturnType<typeof vi.fn>;
  let originalMatchMedia: typeof window.matchMedia | undefined;

  beforeEach(() => {
    raf = installRafHarness();
    scrollIntoView = vi.fn();
    Element.prototype.scrollIntoView = scrollIntoView;
    originalMatchMedia = window.matchMedia;
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: false, media: '', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })),
    });
  });

  afterEach(() => {
    cleanup();
    (window as unknown as { metis: unknown }).metis = undefined;
    if (originalMatchMedia) Object.defineProperty(window, 'matchMedia', { configurable: true, value: originalMatchMedia });
  });

  it('keeps one animation frame for synchronous stream chunks and follows near-bottom output', async () => {
    const pending = deferred<AgentResponse>();
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    renderChat();
    await sendQuestion('测试流式滚动？', metis);

    const container = document.querySelector('.chat-messages') as HTMLElement;
    setScrollGeometry(container, 550);
    raf.clear();
    scrollIntoView.mockClear();
    const requestsBefore = raf.request.mock.calls.length;

    handlers.stream?.({ content: '第一段', reasoning: '先', isFinished: false });
    handlers.stream?.({ content: '第二段', reasoning: '后', isFinished: false });

    expect(raf.request.mock.calls.length - requestsBefore).toBe(1);
    expect(screen.queryByText('第一段第二段')).toBeNull();

    await act(async () => { raf.flushOne(); });
    await act(async () => { raf.flushAll(); });
    expect(await screen.findByText('第一段第二段')).toBeDefined();
    expect(screen.getByText('先后')).toBeDefined();
    // Streaming follow-scroll is an instant ledger-recorded pin, not a
    // per-frame smooth scrollIntoView (which restarted its animation every
    // frame and janked).
    expect(container.scrollTop).toBe(1000);
    expect(scrollIntoView).not.toHaveBeenCalled();
  });

  it('stops following after the user scrolls up and exposes return-to-latest', async () => {
    const pending = deferred<AgentResponse>();
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    renderChat();
    await sendQuestion('测试用户滚动？', metis);

    const container = document.querySelector('.chat-messages') as HTMLElement;
    setScrollGeometry(container, 300);
    raf.clear();
    scrollIntoView.mockClear();
    fireEvent.scroll(container);
    expect(screen.getByTestId('return-to-latest')).toBeDefined();

    handlers.stream?.({ content: '用户上滚时的内容', isFinished: false });
    await act(async () => { raf.flushAll(); });
    expect(await screen.findByText('用户上滚时的内容')).toBeDefined();
    expect(scrollIntoView).not.toHaveBeenCalled();

    fireEvent.click(screen.getByTestId('return-to-latest'));
    await waitFor(() => expect(screen.queryByTestId('return-to-latest')).toBeNull());
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'smooth', block: 'end' });
  });

  it('treats the 72px boundary as near-bottom and 73px as scrolled away', async () => {
    const { metis } = mockMetis({ agentChat: vi.fn(async () => makeAgentResponse('completed', '边界测试回复')) });
    renderChat();
    await sendQuestion('测试滚动阈值？', metis);
    const container = document.querySelector('.chat-messages') as HTMLElement;
    setScrollGeometry(container, 528);
    fireEvent.scroll(container);
    expect(screen.queryByTestId('return-to-latest')).toBeNull();
    Object.defineProperty(container, 'scrollTop', { configurable: true, writable: true, value: 527 });
    fireEvent.scroll(container);
    expect(screen.getByTestId('return-to-latest')).toBeDefined();
  });

  it('uses auto scrolling when reduced motion is requested', async () => {
    Object.defineProperty(window, 'matchMedia', {
      configurable: true,
      value: vi.fn(() => ({ matches: true, media: '(prefers-reduced-motion: reduce)', onchange: null, addListener: vi.fn(), removeListener: vi.fn(), addEventListener: vi.fn(), removeEventListener: vi.fn(), dispatchEvent: vi.fn() })),
    });
    const { metis } = mockMetis({ agentChat: vi.fn(async () => makeAgentResponse('completed', '减少动画回复')) });
    renderChat();
    await sendQuestion('测试减少动画？', metis);
    const container = document.querySelector('.chat-messages') as HTMLElement;
    setScrollGeometry(container, 300);
    fireEvent.scroll(container);
    fireEvent.click(screen.getByTestId('return-to-latest'));
    expect(scrollIntoView).toHaveBeenCalledWith({ behavior: 'auto', block: 'end' });
  });
});
