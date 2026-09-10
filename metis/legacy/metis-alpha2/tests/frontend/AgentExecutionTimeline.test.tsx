/**
 * Agent execution timeline regression tests.
 *
 * These tests deliberately feed the public AgentResponse / Goal IPC shapes
 * that the renderer already consumes. They prove the UI is not populated by
 * a second mock-only state machine.
 *
 * @vitest-environment jsdom
 */
import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { act, cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatPage, { ToolCallCard } from '../../src/pages/ChatPage';
import AgentActivityTimeline from '../../src/components/AgentActivityTimeline';
import {
  normalizeAssistantEvent,
  reduceAssistantMessagePartsBatch,
} from '../../src/lib/assistantMessagePartsReducer';
import type { AgentExecutionEvent, AgentResponse } from '../../engine/runtime/ChatRuntimeContract';

type AgentExecutionListener = (payload: {
  turnId: string;
  event: AgentResponse['events'][number];
} | AgentExecutionEvent) => void;

beforeAll(() => {
  if (typeof Element.prototype.scrollIntoView === 'undefined') {
    Element.prototype.scrollIntoView = () => {};
  }
  if (typeof globalThis.ResizeObserver === 'undefined') {
    globalThis.ResizeObserver = class ResizeObserver {
      observe() {}
      unobserve() {}
      disconnect() {}
    } as unknown as typeof ResizeObserver;
  }
});

afterEach(() => {
  cleanup();
  window.localStorage.clear();
  delete (window as unknown as Record<string, unknown>).metis;
});

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => { resolve = done; });
  return { promise, resolve };
}

function mockMetis(overrides: Record<string, unknown> = {}) {
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
    onGoalChanged: vi.fn(() => () => {}),
    onAgentExecutionEvent: vi.fn((listener: AgentExecutionListener) => {
      void listener;
      return () => {};
    }),
    agentChat: vi.fn(),
    ...overrides,
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
}

function renderChat() {
  return render(<ChatPage renderLayout={(slots) => <div>{slots.workspace}</div>} uiMode="production" />);
}

async function send(text: string, metis: ReturnType<typeof mockMetis>) {
  await waitFor(() => expect(metis.getMessages).toHaveBeenCalled());
  fireEvent.change(screen.getByPlaceholderText('提出一个研究问题...'), { target: { value: text } });
  fireEvent.click(screen.getByText('发送'));
}

describe('Agent execution timeline', () => {
  it('renders only the active renderer turn\'s live execution events before the final response and preserves them on settlement', async () => {
    const pending = deferred<AgentResponse>();
    let liveListener: AgentExecutionListener | undefined;
    const metis = mockMetis({
      agentChat: vi.fn(() => pending.promise),
      onAgentExecutionEvent: vi.fn((listener: AgentExecutionListener) => {
        liveListener = listener;
        return () => { if (liveListener === listener) liveListener = undefined; };
      }),
    });
    renderChat();
    await send('这个研究设计有什么问题？', metis);

    await waitFor(() => {
      expect(screen.getByTestId('active-run-timeline').textContent).toContain('运行已发起，等待模型响应');
    });

    const options = (metis.agentChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as { turnId?: string };
    expect(options.turnId).toMatch(/^chat-/);
    await waitFor(() => expect(liveListener).toBeDefined());

    act(() => {
      liveListener?.({
        turnId: 'chat-a-different-request',
        event: { type: 'lifecycle', phase: 'started', timestamp: 9, summary: '不应串入其他请求' },
      });
      liveListener?.({
        turnId: options.turnId!,
        event: { type: 'lifecycle', phase: 'started', timestamp: 10, summary: '已开始分析研究设计' },
      });
      liveListener?.({
        turnId: options.turnId!,
        event: { type: 'action', action: 'web_search', status: 'completed', timestamp: 20, summary: '检索到 8 篇方法论文' },
      });
      liveListener?.({
        turnId: options.turnId!,
        event: { type: 'progress', completed: 2, total: 2, timestamp: 30, label: '证据整理完成' },
      });
    });

    expect(screen.getByTestId('active-run-timeline').textContent).toContain('已开始分析研究设计');
    expect(screen.getByTestId('active-run-timeline').textContent).toContain('检索到 8 篇方法论文');
    expect(screen.queryByText('不应串入其他请求')).toBeNull();

    pending.resolve({
      version: 1,
      turnId: options.turnId!,
      status: 'completed',
      answer: '研究设计已经完成初步检查。',
      diagnostics: [],
      citations: [],
      events: [],
    });

    await waitFor(() => {
      expect(screen.getByText('研究设计已经完成初步检查。')).toBeDefined();
      expect(screen.getByText('已开始分析研究设计')).toBeDefined();
      expect(screen.getByText('检索到 8 篇方法论文')).toBeDefined();
      expect(screen.getByText('证据整理完成')).toBeDefined();
    });
    const completedTimeline = screen.getByTestId('agent-activity-timeline');
    expect(completedTimeline.querySelector('summary')?.getAttribute('aria-live')).toBeNull();
    expect(screen.queryByTestId('active-run-timeline')).toBeNull();
  });

  it('repairs an active-turn sequence gap from durable replay without duplicating the timeline', async () => {
    const pending = deferred<AgentResponse>();
    let liveListener: AgentExecutionListener | undefined;
    let replayTurnId = '';
    const replayAgentEvents = vi.fn(async () => ({
      version: 1 as const,
      sessionId: 'session-a',
      runId: replayTurnId,
      afterSequence: 0,
      events: [
        {
          version: 1 as const,
          eventId: `${replayTurnId}:1`,
          runId: replayTurnId,
          sessionId: 'session-a',
          turnId: replayTurnId,
          sequence: 1,
          correlationId: replayTurnId,
          event: { type: 'action' as const, action: 'tool:lookup', status: 'completed' as const, timestamp: 11, summary: '回放补齐的检索' },
        },
        {
          version: 1 as const,
          eventId: `${replayTurnId}:2`,
          runId: replayTurnId,
          sessionId: 'session-a',
          turnId: replayTurnId,
          sequence: 2,
          correlationId: replayTurnId,
          event: { type: 'progress' as const, completed: 2, total: 2, timestamp: 12, label: '回放补齐的进度' },
        },
      ],
    }));
    const metis = mockMetis({
      agentChat: vi.fn(() => pending.promise),
      onAgentExecutionEvent: vi.fn((listener: AgentExecutionListener) => {
        liveListener = listener;
        return () => { if (liveListener === listener) liveListener = undefined; };
      }),
      replayAgentEvents,
    });
    renderChat();
    await send('活动回合回放测试', metis);
    const optionsForTest = (metis.agentChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as { turnId: string };
    replayTurnId = optionsForTest.turnId;
    await waitFor(() => expect(liveListener).toBeDefined());

    act(() => {
      liveListener?.({
        version: 1,
        eventId: `${optionsForTest.turnId}:0`, runId: optionsForTest.turnId, sessionId: 'session-a', turnId: optionsForTest.turnId,
        sequence: 0, correlationId: optionsForTest.turnId,
        event: { type: 'lifecycle', phase: 'started', timestamp: 10, summary: '已开始' },
      });
      liveListener?.({
        version: 1,
        eventId: `${optionsForTest.turnId}:2`, runId: optionsForTest.turnId, sessionId: 'session-a', turnId: optionsForTest.turnId,
        sequence: 2, correlationId: optionsForTest.turnId,
        event: { type: 'progress', completed: 2, total: 2, timestamp: 12, label: '实时已到末端' },
      });
    });

    await waitFor(() => expect(replayAgentEvents).toHaveBeenCalledWith({
      version: 1, sessionId: 'session-a', runId: optionsForTest.turnId, afterSequence: 0, limit: 256,
    }));
    expect(await screen.findByText('回放补齐的检索')).toBeDefined();
    expect(screen.getByText('实时已到末端')).toBeDefined();
    expect(screen.queryByText('回放补齐的进度')).toBeNull();
    expect(screen.getByTestId('agent-activity-events').querySelectorAll('li')).toHaveLength(3);

    pending.resolve({
      version: 1, turnId: optionsForTest.turnId, status: 'completed', answer: '回放测试完成。', diagnostics: [], citations: [], events: [],
    });
    await screen.findByText('回放测试完成。');
  });

  it('unsubscribes from the live execution channel when the chat view unmounts', async () => {
    const unsubscribe = vi.fn();
    const metis = mockMetis({ onAgentExecutionEvent: vi.fn(() => unsubscribe) });
    const view = renderChat();
    await waitFor(() => expect(metis.onAgentExecutionEvent).toHaveBeenCalledTimes(1));
    view.unmount();
    expect(unsubscribe).toHaveBeenCalledTimes(1);
  });

  it('uses the final runtime trace instead of duplicating the live fallback events', async () => {
    const pending = deferred<AgentResponse>();
    let liveListener: AgentExecutionListener | undefined;
    const metis = mockMetis({
      agentChat: vi.fn(() => pending.promise),
      onAgentExecutionEvent: vi.fn((listener: AgentExecutionListener) => {
        liveListener = listener;
        return () => {};
      }),
    });
    renderChat();
    await send('请运行一次有事件的研究分析', metis);
    const options = (metis.agentChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[3] as { turnId?: string };
    await waitFor(() => expect(liveListener).toBeDefined());
    act(() => {
      liveListener?.({
        turnId: options.turnId!,
        event: { type: 'action', action: 'web_search', status: 'completed', timestamp: 10, summary: '仅实时出现的旧事件' },
      });
    });

    pending.resolve({
      version: 1,
      turnId: options.turnId!,
      status: 'completed',
      answer: '最终回答。',
      diagnostics: [],
      citations: [],
      events: [{ type: 'progress', completed: 1, total: 1, timestamp: 20, label: '最终权威事件' }],
    });

    await screen.findByText('最终回答。');
    expect(screen.getByText('最终权威事件')).toBeDefined();
    expect(screen.queryByText('仅实时出现的旧事件')).toBeNull();
    expect(screen.getByTestId('agent-activity-events').querySelectorAll('li')).toHaveLength(1);
  });

  it('hides real runtime hook identifiers in production, preserves them in diagnostics, and keeps a user-collapsed running timeline closed', () => {
    vi.useFakeTimers();
    try {
      const runtimeEvent: AgentResponse['events'][number] = {
        type: 'action', action: 'model.request', status: 'running', timestamp: 10, summary: 'model.request',
      };
      const view = render(
        <AgentActivityTimeline
          status="running"
          events={[runtimeEvent]}
          startedAt={Date.now()}
          locale="zh"
        />,
      );
      const timeline = screen.getByTestId('agent-activity-timeline') as HTMLDetailsElement;
      expect(timeline.open).toBe(true);
      expect(screen.queryByText('model.request')).toBeNull();

      timeline.open = false;
      fireEvent(timeline, new Event('toggle', { bubbles: true }));
      expect(timeline.open).toBe(false);
      act(() => { vi.advanceTimersByTime(1_000); });
      expect(timeline.open).toBe(false);

      view.rerender(
        <AgentActivityTimeline
          status="running"
          events={[runtimeEvent]}
          startedAt={Date.now()}
          locale="zh"
          diagnosticMode
        />,
      );
      expect(screen.getByText('model.request')).toBeDefined();
    } finally {
      vi.useRealTimers();
    }
  });

  it('merges real tool-result updates by tool call and exposes only returned detail and sources on expansion', () => {
    render(
      <AgentActivityTimeline
        status="completed"
        locale="zh"
        events={[
          {
            type: 'tool_result',
            toolCallId: 'tool-call-evidence-1',
            toolName: 'web_search',
            status: 'completed',
            timestamp: 10,
            summary: '已找到可核验来源',
            detail: '工具返回了两篇可核验的方法文献。',
            sources: [{ label: '研究方法来源', url: 'https://example.com/methods' }],
          },
          {
            type: 'tool_result',
            toolCallId: 'tool-call-evidence-1',
            toolName: 'web_search',
            status: 'completed',
            timestamp: 11,
            summary: '证据检索完成',
            sources: [],
          },
        ]}
      />,
    );

    const cards = screen.getAllByTestId('agent-tool-result') as HTMLDetailsElement[];
    expect(cards).toHaveLength(1);
    expect(screen.getByTestId('agent-activity-timeline').textContent).toContain('1 条运行事件');
    expect(cards[0]!.open).toBe(false);

    fireEvent.click(cards[0]!.querySelector('summary')!);
    expect(cards[0]!.open).toBe(true);
    expect(screen.getByText('工具返回了两篇可核验的方法文献。')).toBeDefined();
    const source = screen.getByRole('link', { name: '研究方法来源' });
    expect(source.getAttribute('href')).toBe('https://example.com/methods');
  });

  it('shows a retention-gap notice for a completed timeline and hides args outside diagnostics', () => {
    const toolEvent: AgentResponse['events'][number] = {
      type: 'tool_result',
      toolCallId: 'tool-retained-1',
      toolName: 'web_search',
      status: 'completed',
      timestamp: 10,
      detail: '保留的工具结果',
      sources: [],
    };
    const parts = reduceAssistantMessagePartsBatch([
      {
        kind: 'tool', phase: 'args', toolCallId: 'tool-retained-1', name: 'web_search',
        arguments: '{"query":"private marker"}', sequence: 1,
      },
      normalizeAssistantEvent(toolEvent),
    ]);
    const view = render(
      <AgentActivityTimeline
        status="completed"
        events={[toolEvent]}
        parts={parts}
        locale="zh"
        historyIncomplete
      />,
    );
    expect(screen.getByText('执行历史已部分裁剪，以下仅显示保留的事件。')).toBeDefined();
    const card = screen.getByTestId('agent-tool-result');
    fireEvent.click(card.querySelector('summary')!);
    expect(screen.getByText('保留的工具结果')).toBeDefined();
    expect(screen.queryByText('{"query":"private marker"}')).toBeNull();

    view.rerender(
      <AgentActivityTimeline
        status="completed"
        events={[toolEvent]}
        parts={parts}
        locale="zh"
        diagnosticMode
        historyIncomplete
      />,
    );
    expect(screen.getByText('{"query":"private marker"}')).toBeDefined();
  });

  it('deduplicates duplicate and late cancelled execution envelopes in the canonical reducer', () => {
    const cancelled = normalizeAssistantEvent({
      type: 'lifecycle', phase: 'interrupted', timestamp: 20, eventId: 'cancelled', sequence: 2,
    });
    const lateStarted = normalizeAssistantEvent({
      type: 'lifecycle', phase: 'started', timestamp: 10, eventId: 'late-start', sequence: 1,
    });
    const state = reduceAssistantMessagePartsBatch([
      cancelled,
      cancelled,
      lateStarted,
      { ...cancelled, eventId: 'cancelled-copy' },
    ]);
    expect(state.run.status).toBe('interrupted');
    expect(state.run.events.filter((event) => event.type === 'lifecycle')).toHaveLength(1);
  });

  it('hydrates a completed retained run with a visible metadata retention-gap notice', async () => {
    const metis = mockMetis({
      getMessages: vi.fn(async () => [{
        kind: 'message',
        role: 'assistant',
        content: '已恢复的完成回答',
        metadata: { runId: 'run-retained-1', status: 'completed', eventsPruned: true },
      }]),
      replayAgentEvents: vi.fn(async () => ({
        version: 1 as const,
        sessionId: 'session-a',
        runId: 'run-retained-1',
        afterSequence: -1,
        events: [],
        retentionGap: false,
      })),
    });
    renderChat();
    expect(await screen.findByText('已恢复的完成回答')).toBeDefined();
    expect(await screen.findByText('执行历史已部分裁剪，以下仅显示保留的事件。')).toBeDefined();
    await waitFor(() => expect(metis.replayAgentEvents).toHaveBeenCalled());
    expect(metis.replayAgentEvents).toHaveBeenCalledWith({
      version: 1,
      sessionId: 'session-a',
      runId: 'run-retained-1',
      afterSequence: -1,
      limit: 256,
    });
  });

  it('retains a cancelled run as a compact execution record instead of presenting it as a completed answer', async () => {
    const metis = mockMetis({
      agentChat: vi.fn(async (): Promise<AgentResponse> => ({
        version: 1,
        turnId: 'turn-cancelled-1',
        status: 'cancelled',
        answer: '',
        diagnostics: [],
        citations: [],
        events: [],
      })),
    });
    renderChat();
    await send('这项研究现在完成了吗？', metis);

    await waitFor(() => {
      expect(screen.getByText(/任务已中断/)).toBeDefined();
      expect(screen.getByTestId('agent-activity-timeline').textContent).toContain('已取消');
    });
    expect(screen.queryByText('研究设计已经完成初步检查。')).toBeNull();
  });

  it('drives pause and resume from the visible Goal Workflow card without claiming a pause before the engine returns paused', async () => {
    const execution = deferred<{ success: boolean; code?: 'paused' }>();
    const metis = mockMetis({
      createGoal: vi.fn(async () => ({ success: true, goalId: 'goal-ui-1', status: 'draft' })),
      generatePlan: vi.fn(async () => ({
        success: true,
        goalId: 'goal-ui-1',
        label: 'Research plan',
        steps: [{ stepId: 'step-ui-1', label: 'Research step', ordinal: 1 }],
      })),
      getGoalWorkflow: vi.fn(async () => ({
        success: true,
        goalId: 'goal-ui-1',
        workflow: {
          id: 'workflow-ui-1', name: '文献证据工作流', description: '检索并归纳方法证据', version: 'v1',
          steps: [{ id: 'step-ui-1', name: '检索方法文献', description: '收集可核验的研究资料', prompt: 'search', tools: ['web_search'], maxTurns: 3 }],
          dependencies: {},
        },
        stepResults: { 'step-ui-1': { status: 'running', output: '', retryCount: 0 } },
      })),
      executeGoal: vi.fn(() => execution.promise),
      pauseGoal: vi.fn(async () => ({ success: true, code: 'pause_requested' })),
      resumeGoal: vi.fn(async () => ({ success: true, code: 'completed' })),
      cancelGoal: vi.fn(async () => ({ success: true })),
    });
    renderChat();
    await send('请帮我完成一份完整的方法文献综述计划', metis);

    const timeline = await screen.findByTestId('goal-execution-timeline');
    expect(timeline.textContent).toContain('检索方法文献');
    fireEvent.click(screen.getByTestId('goal-pause'));
    await waitFor(() => {
      expect(metis.pauseGoal).toHaveBeenCalledWith('goal-ui-1');
      // 2026-08-29 刘总确认的暂停文案：说明暂停时机与恢复入口。
      expect(screen.getByTestId('goal-pause-requested').textContent).toContain('暂停请求中');
    });

    await act(async () => {
      execution.resolve({ success: false, code: 'paused' });
    });
    const resume = await screen.findByTestId('goal-resume');
    fireEvent.click(resume);
    await waitFor(() => {
      expect(metis.resumeGoal).toHaveBeenCalledWith('goal-ui-1');
    });
    await waitFor(() => {
      expect(screen.queryByTestId('goal-resume')).toBeNull();
    });
  });

  it('does not hydrate an old goal workflow into a newly selected session after the workflow read resolves late', async () => {
    const workflowLoad = deferred<{
      success: true;
      goalId: string;
      workflow: {
        id: string; name: string; description: string; version: string;
        steps: Array<{ id: string; name: string; description: string; prompt: string; tools: string[]; maxTurns: number }>;
        dependencies: Record<string, string[]>;
      };
      stepResults: Record<string, { status: 'pending'; output: string; retryCount: number }>;
    }>();
    const execution = deferred<{ success: boolean }>();
    const metis = mockMetis({
      listSessions: vi.fn(async () => ({
        success: true,
        sessions: [
          { id: 'session-a', title: '会话 A', createdAt: 2, lastActivity: 2, messageCount: 0, archived: false },
          { id: 'session-b', title: '会话 B', createdAt: 1, lastActivity: 1, messageCount: 1, archived: false },
        ],
      })),
      getMessages: vi.fn(async (sessionId: string) => (sessionId === 'session-b'
        ? [{
          kind: 'goal',
          goal: {
            goalId: 'goal-b', description: '会话 B 目标', phase: 'plan_ready',
            steps: [], stepStatuses: {}, progress: { completed: 0, total: 0, currentStep: '' }, canRefine: false,
          },
        }]
        : [])),
      createGoal: vi.fn(async () => ({ success: true, goalId: 'goal-a', status: 'draft' })),
      generatePlan: vi.fn(async () => ({
        success: true, goalId: 'goal-a', label: 'A plan',
        steps: [{ stepId: 'a-step', label: '旧会话的私有步骤', ordinal: 1 }],
      })),
      getGoalWorkflow: vi.fn(() => workflowLoad.promise),
      executeGoal: vi.fn(() => execution.promise),
    });
    render(<ChatPage renderLayout={(slots) => <div>{slots.leftPanel}{slots.workspace}</div>} uiMode="production" />);
    await send('请帮我完成一份完整的方法文献综述计划', metis);
    await waitFor(() => expect(metis.getGoalWorkflow).toHaveBeenCalledWith('goal-a'));

    fireEvent.click(screen.getByText('会话 B', { selector: '.chat-session-title' }).closest('.chat-session-item')!);
    expect(await screen.findByText('会话 B 目标')).toBeDefined();

    await act(async () => {
      workflowLoad.resolve({
        success: true,
        goalId: 'goal-a',
        workflow: {
          id: 'workflow-a', name: '旧会话工作流', description: '只属于旧会话', version: 'v1',
          steps: [{ id: 'a-step', name: '旧会话的私有步骤', description: '不得写入会话 B', prompt: 'search', tools: ['web_search'], maxTurns: 1 }],
          dependencies: {},
        },
        stepResults: { 'a-step': { status: 'pending', output: '', retryCount: 0 } },
      });
      await Promise.resolve();
    });

    expect(screen.getByText('会话 B 目标')).toBeDefined();
    expect(screen.queryByText('旧会话的私有步骤')).toBeNull();
  });
});

describe('Tool call card presentation', () => {
  it('keeps the real tool card compact by default and exposes its returned result on keyboard-accessible expansion', () => {
    render(
      <ToolCallCard
        diagnosticMode={false}
        toolCall={{ name: 'web_search', arguments: '{"query":"methodology"}', result: '找到 8 篇可核验的方法论文。', status: 'completed' }}
      />,
    );
    expect(screen.queryByText('找到 8 篇可核验的方法论文。')).toBeNull();
    const cardToggle = screen.getByRole('button');
    expect(cardToggle.getAttribute('aria-expanded')).toBe('false');
    fireEvent.click(cardToggle);
    expect(cardToggle.getAttribute('aria-expanded')).toBe('true');
    expect(screen.getByText('找到 8 篇可核验的方法论文。')).toBeDefined();
  });
});
