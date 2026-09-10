/**
 * Implicit session creation — sending a message without clicking 「新会话」
 * first must auto-create and persist a session (previously the conversation
 * stayed ephemeral: sidebar showed 无会话 and history vanished on reload).
 *
 * @vitest-environment jsdom
 */

import { afterEach, beforeAll, describe, expect, it, vi } from 'vitest';
import { cleanup, fireEvent, render, screen, waitFor } from '@testing-library/react';
import ChatPage from '../../src/pages/ChatPage';
import type { AgentResponse } from '../../engine/runtime/ChatRuntimeContract';

function makeAgentResponse(answer: string): AgentResponse {
  return { version: 1, turnId: 'turn-1', status: 'completed', answer, diagnostics: [], citations: [], events: [] };
}

function mockMetis() {
  const metis = {
    listSessions: vi.fn(async () => ({ success: true, sessions: [] })),
    createSession: vi.fn(async () => ({ success: true })),
    updateSession: vi.fn(async () => ({ success: true })),
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
    agentChat: vi.fn(async () => makeAgentResponse('好的，这是回答。')),
    agentControl: vi.fn(),
    onChatStreamChunk: vi.fn(() => () => {}),
  };
  (window as unknown as { metis: unknown }).metis = metis;
  return metis;
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

describe('ChatPage implicit session creation (F2)', () => {
  it('auto-creates a persisted session when sending without clicking 新会话', async () => {
    const metis = mockMetis();
    render(<ChatPage renderLayout={(slots) => <div>{slots.workspace}</div>} uiMode="production" />);

    const input = await screen.findByPlaceholderText('提出一个研究问题...');
    fireEvent.change(input, { target: { value: '什么是元分析？' } });
    fireEvent.click(screen.getByText('发送'));

    // session must be created and the turn must go through WITH that session id
    await waitFor(() => expect(metis.createSession).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(metis.agentChat).toHaveBeenCalled());
    const chatSessionId = (metis.agentChat as ReturnType<typeof vi.fn>).mock.calls[0]?.[0];
    expect(typeof chatSessionId).toBe('string');
    expect(chatSessionId).toMatch(/^session_\d+$/);

    // sidebar lists the new session (no longer 无会话) with an auto title
    await waitFor(() => expect(screen.queryByText('无会话')).toBeNull());
    await waitFor(() => expect(metis.updateSession).toHaveBeenCalled());
  });
});
