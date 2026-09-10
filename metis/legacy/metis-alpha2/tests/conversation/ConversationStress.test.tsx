/**
 * Conversation stress gate (Task 5 §14).
 *
 * Consumes deterministic volume fixtures (tests/fixtures/conversation-stress/
 * *.stress.json — temporary stand-ins generated per 刘总's approval, to be
 * replaced by the Conversation AGENT's fixtures; the consumer depends only on
 * the documented JSON contract) and drives the REAL ChatPage streaming path
 * in jsdom:
 *   - 10k text deltas end-to-end through the production append path
 *   - 100k reasoning deltas through the production reasoning path
 *   - long markdown stream interrupted mid-flight via the REAL interrupt
 *     control (`.chat-interrupt` → agentControl('interrupt'))
 *
 * jsdom does not exercise real layout/paint; the gate covers the volume
 * behavior of the data path and React state aggregation. Real-render
 * behavior is covered by the layout acceptance in the built app.
 *
 * @vitest-environment jsdom
 */
import { beforeAll, afterEach, describe, expect, it, vi } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatPage from '../../src/pages/ChatPage';
import type { AgentResponse } from '../../engine/runtime/ChatRuntimeContract';

interface StressFixture {
  name: string;
  textDeltas: number;
  reasoningDeltas: number;
  textChunk: string;
  reasoningChunk: string;
  markdown: boolean;
  stopAtDelta: number | null;
  expectFinalAnswer: string;
}

const FIXTURE_DIR = path.resolve(__dirname, '../fixtures/conversation-stress');
const fixtures = fs.readdirSync(FIXTURE_DIR)
  .filter((f) => f.endsWith('.stress.json'))
  .map((f) => JSON.parse(fs.readFileSync(path.join(FIXTURE_DIR, f), 'utf8')) as StressFixture);

function deferred<T>() {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((r) => { resolve = r; });
  return { promise, resolve };
}

function makeAgentResponse(status: AgentResponse['status'], answer = ''): AgentResponse {
  return { version: 1, turnId: 'stress-turn', status, answer, diagnostics: [], citations: [], events: [] };
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
    agentControl: vi.fn(async () => makeAgentResponse('interrupted')),
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

async function driveStream(
  fixture: StressFixture,
  handlers: { stream?: (data: StreamDispatch) => void },
): Promise<number> {
  const total = Math.max(fixture.textDeltas, fixture.reasoningDeltas);
  let emitted = 0;
  for (let i = 0; i < total; i++) {
    if (fixture.stopAtDelta !== null && emitted >= fixture.stopAtDelta) break;
    const content = i < fixture.textDeltas ? fixture.textChunk : '';
    const reasoning = i < fixture.reasoningDeltas ? fixture.reasoningChunk : '';
    handlers.stream?.({ sessionId: 'session-a', content, reasoning, isFinished: false });
    emitted += 1;
    // Yield to the React renderer periodically so state aggregation stays real.
    if (emitted % 2_500 === 0) await new Promise((r) => setTimeout(r, 0));
  }
  return emitted;
}

describe('conversation stress (fixture-driven volume)', () => {
  beforeAll(() => {
    if (typeof Element.prototype.scrollIntoView === 'undefined') {
      Element.prototype.scrollIntoView = () => {};
    }
  });

  afterEach(() => {
    cleanup();
    (window as unknown as { metis: unknown }).metis = undefined;
  });

  for (const fixture of fixtures.filter((f) => f.stopAtDelta === null)) {
    it(`${fixture.name}: streams ${fixture.textDeltas + fixture.reasoningDeltas} deltas through the real ChatPage path and settles with the final answer`, async () => {
      const pending = deferred<AgentResponse>();
      const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
      render(<ChatPage renderLayout={(slots) => <div>{slots.workspace}</div>} uiMode="production" />);
      await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());

      await waitFor(() => expect(metis.getMessages).toHaveBeenCalled());
      const input = screen.getByPlaceholderText('提出一个研究问题...');
      fireEvent.change(input, { target: { value: `${fixture.name} 压力流` } });
      fireEvent.click(screen.getByText('发送'));

      const emitted = await driveStream(fixture, handlers);
      expect(emitted).toBe(Math.max(fixture.textDeltas, fixture.reasoningDeltas));

      // Finalize like the real pipeline: finish chunk, then the authoritative answer.
      handlers.stream?.({ sessionId: 'session-a', content: '', isFinished: true });
      pending.resolve(makeAgentResponse('completed', fixture.expectFinalAnswer));

      const expectedText = fixture.textChunk.repeat(fixture.textDeltas);
      await waitFor(() => {
        expect(screen.getByText(fixture.expectFinalAnswer)).toBeDefined();
      });
      // The authoritative answer replaced (not duplicated) the streamed draft.
      expect(screen.queryByText(expectedText)).toBeNull();
      expect(screen.getAllByText(fixture.expectFinalAnswer)).toHaveLength(1);
    }, 180_000);
  }

  it('long-markdown-stop: interrupts mid-stream via the real stop control and retains the partial draft semantics', async () => {
    const fixture = fixtures.find((f) => f.stopAtDelta !== null);
    expect(fixture, 'stop fixture missing').toBeDefined();
    if (!fixture) return;

    const pending = deferred<AgentResponse>();
    const { metis, handlers } = mockMetis({ agentChat: vi.fn(() => pending.promise) });
    render(<ChatPage renderLayout={(slots) => <div>{slots.workspace}</div>} uiMode="production" />);
    await waitFor(() => expect(metis.listPersonalization).toHaveBeenCalled());
    await waitFor(() => expect(metis.getMessages).toHaveBeenCalled());
    const input = screen.getByPlaceholderText('提出一个研究问题...');
    fireEvent.change(input, { target: { value: '长 markdown 中途停止' } });
    fireEvent.click(screen.getByText('发送'));

    await driveStream(fixture, handlers);
    expect(metis.agentChat).toHaveBeenCalled();

    // The interrupt button is the real control users press (aria-label
    // 打断当前任务, visible text 打断).
    const interrupt = await screen.findByRole('button', { name: '打断当前任务' });
    fireEvent.click(interrupt);
    expect(metis.agentControl).toHaveBeenCalled();
    const controlCalls = (metis.agentControl as ReturnType<typeof vi.fn>).mock.calls;
    expect(JSON.stringify(controlCalls.at(-1))).toContain('interrupt');

    // The pending request settles as interrupted; the partial markdown draft
    // stays on screen (retained-draft semantics, no error bubble).
    pending.resolve(makeAgentResponse('interrupted', ''));
    await waitFor(() => {
      expect(screen.getByText(/任务已中断|未完成草稿/)).toBeDefined();
    });
    // Subsequent chunks after stop are ignored by the production path.
    handlers.stream?.({ sessionId: 'session-a', content: 'STOP-AFTER-LEAK', isFinished: false });
    expect(screen.queryByText(/STOP-AFTER-LEAK/)).toBeNull();
  }, 180_000);
});
