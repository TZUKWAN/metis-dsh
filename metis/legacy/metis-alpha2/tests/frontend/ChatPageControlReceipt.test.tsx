// @vitest-environment jsdom
/**
 * METIS-F11 — Interrupt/steering receipts and dynamic Full Access policy badge.
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatPage from '../../src/pages/ChatPage';
import type { AgentResponse } from '../../engine/runtime/ChatRuntimeContract';

beforeAll(() => {
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof globalThis.ResizeObserver;
  }
  if (typeof Element.prototype.scrollIntoView === 'undefined') {
    Element.prototype.scrollIntoView = () => {};
  }
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).metis;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeAgentResponse(status: AgentResponse['status'], answer = ''): AgentResponse {
  return { version: 1, turnId: 'turn-1', status, answer, diagnostics: [], citations: [], events: [] };
}

function mockMetis(overrides: Record<string, unknown> = {}) {
  const metis = {
    listSessions: vi.fn(async () => ({ success: true, sessions: [] })),
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
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

function renderChat() {
  return render(<ChatPage renderLayout={(slots) => <div>{slots.workspace}</div>} uiMode="production" />);
}

describe('ChatPage control receipts (METIS-F11)', () => {
  it('no longer renders the redundant scenario/policy bar in the chat workspace', async () => {
    // 2026-08-28 刘总要求：项目头部已有场景工作流，聊天区的场景行与
    // Full Access 徽标属于重复展示，必须移除且不得回归。
    mockMetis();
    renderChat();
    await waitFor(() => {
      expect(screen.getByPlaceholderText('提出一个研究问题...')).toBeDefined();
    });
    expect(screen.queryByTestId('chat-scenario-controls')).toBeNull();
    expect(screen.queryByTestId('chat-policy-status')).toBeNull();
  });

  it('shows an interrupt receipt instead of an error when the run is interrupted', async () => {
    const metis = mockMetis({ agentChat: vi.fn(async () => makeAgentResponse('interrupted')) });
    renderChat();
    // Wait for mount to settle so the metis bridge is fully live before sending.
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    // Question-form content routes to chat flow (isTaskLike returns false for '？').
    fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), { target: { value: '这篇论文有哪些不足？' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => {
      expect(metis.agentChat).toHaveBeenCalled();
      expect(screen.getByText(/任务已中断/)).toBeDefined();
    });
    // The interrupt must never be presented as a diagnostic error.
    expect(screen.queryByText(/失败|错误/u)).toBeNull();
  });

  it('confirms an interrupt request with a receipt', async () => {
    const pending = deferred<AgentResponse>();
    mockMetis({
      agentChat: vi.fn(() => pending.promise),
      agentControl: vi.fn(async () => ({
        ok: true, contractVersion: 1, operationId: 'op-int-1', action: 'interrupt', sequence: 1,
      })),
    });
    renderChat();
    fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), { target: { value: '跑一个检索任务' } });
    fireEvent.click(screen.getByText('发送'));
    // While the run is in flight the send button becomes the steer button.
    await waitFor(() => expect(screen.getByText('引导')).toBeDefined());

    fireEvent.click(screen.getByLabelText('打断当前任务'));
    await waitFor(() => {
      expect(screen.getByText(/已发送中断请求/)).toBeDefined();
    });

    // The run settles as interrupted: the receipt persists.
    pending.resolve(makeAgentResponse('interrupted'));
    await waitFor(() => {
      expect(screen.getByText(/任务已中断/)).toBeDefined();
    });
  });

  it('confirms a steering instruction with a receipt', async () => {
    const pending = deferred<AgentResponse>();
    const agentControl = vi.fn(async () => ({
      ok: true, contractVersion: 1, operationId: 'op-steer-1', action: 'instruction', sequence: 2,
    }));
    mockMetis({ agentChat: vi.fn(() => pending.promise), agentControl });
    renderChat();
    fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), { target: { value: '开始第一轮检索' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(screen.getByText('引导')).toBeDefined());

    fireEvent.change(screen.getByPlaceholderText('输入新指令，实时引导当前任务…'), { target: { value: '请优先聚焦方法部分' } });
    fireEvent.click(screen.getByText('引导'));
    await waitFor(() => {
      expect(agentControl).toHaveBeenCalledWith(expect.objectContaining({ action: 'instruction' }));
      expect(screen.getByText(/引导指令已生效/)).toBeDefined();
    });

    pending.resolve(makeAgentResponse('completed', '已完成检索。'));
    await waitFor(() => expect(screen.getByText('已完成检索。')).toBeDefined());
  });

  it('keeps the redundant scenario bar absent while a run is active', async () => {
    const pending = deferred<AgentResponse>();
    const agentChat = vi.fn(() => pending.promise);
    mockMetis({ agentChat });
    renderChat();
    // Question-form content routes to chat flow (isTaskLike returns false for '？').
    fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), { target: { value: '当前方案有什么问题？' } });
    fireEvent.click(screen.getByText('发送'));
    await waitFor(() => expect(agentChat).toHaveBeenCalled());
    expect(screen.queryByTestId('chat-scenario-controls')).toBeNull();
    expect(screen.queryByTestId('chat-policy-status')).toBeNull();
    pending.resolve(makeAgentResponse('completed', '分析完成。'));
    await waitFor(() => expect(screen.getByText('分析完成。')).toBeDefined());
    expect(screen.queryByTestId('chat-scenario-controls')).toBeNull();
  });
});
