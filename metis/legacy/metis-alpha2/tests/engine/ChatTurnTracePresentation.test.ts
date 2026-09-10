import { describe, expect, it } from 'vitest';
import { AgentLoop } from '../../engine/core/AgentLoop.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import { ToolDispatcher } from '../../engine/tools/ToolDispatcher.js';
import { ToolRegistry } from '../../engine/tools/ToolRegistry.js';
import { runEphemeralChatTurn } from '../../electron/ChatTurnService.js';

function createLoop(answer: string): AgentLoop {
  const registry = new ToolRegistry();
  return new AgentLoop({
    provider: new FakeProvider({ response: answer }),
    registry,
    dispatcher: new ToolDispatcher(registry),
  });
}

describe('Chat turn trace presentation', () => {
  it('returns the actual AgentLoop lifecycle and model traces rather than an empty presentation event list', async () => {
    const response = await runEphemeralChatTurn({
      agentLoop: createLoop('基于当前证据的真实回答。'),
      sessionId: 'trace-presentation-session',
      requestId: 'trace-presentation-turn',
      messages: [{ role: 'user', content: '请给出一个简短研究结论。' }],
    });

    expect(response.status).toBe('completed');
    expect(response.events).toEqual([
      expect.objectContaining({ type: 'lifecycle', phase: 'started', summary: 'agent.start' }),
      expect.objectContaining({ type: 'action', action: 'model.request', status: 'running', summary: 'model.request' }),
      expect.objectContaining({ type: 'action', action: 'model.response', status: 'completed', summary: 'model.response' }),
      expect.objectContaining({ type: 'lifecycle', phase: 'completed', summary: 'agent.complete' }),
    ]);
  });
});
