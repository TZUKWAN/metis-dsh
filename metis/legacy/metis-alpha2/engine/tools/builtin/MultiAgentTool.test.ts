/**
 * Tests for the multi-agent orchestration tool wrapper.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';
import { MULTI_AGENT_TOOL, createMultiAgentHandler } from './MultiAgentTool.js';

// Mock the orchestrator so no real agent loop/provider is needed, while
// keeping the real exports (e.g. DEFAULT_AGENT_TEMPLATES) intact.
const executeMock = vi.fn();
vi.mock('../../multiagent/MultiAgentOrchestrator.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../../multiagent/MultiAgentOrchestrator.js')>();
  return {
    ...actual,
    MultiAgentOrchestrator: class {
      execute(...args: never[]) { return executeMock(...args); }
    },
  };
});

describe('multi_agent_orchestrate tool', () => {
  beforeEach(() => {
    executeMock.mockReset();
  });

  it('declares a tool spec with a required task parameter', () => {
    expect(MULTI_AGENT_TOOL.name).toBe('multi_agent_orchestrate');
    const required = MULTI_AGENT_TOOL.parameters.required as string[];
    expect(required).toContain('task');
  });

  it('runs the orchestrator and returns the final output', async () => {
    executeMock.mockResolvedValue({
      status: 'completed',
      finalOutput: 'Synthesized review draft.',
      totalTurns: 7,
      handoffs: [{ from: 'coordinator', to: 'researcher' }],
      errors: [],
    });
    const handler = createMultiAgentHandler({ agentLoop: {} as never });
    const result = await handler({ task: 'Write a lit review on RAG.' }, {} as never);
    expect(result).toContain('completed');
    expect(result).toContain('Synthesized review draft.');
    expect(result).toContain('coordinator→researcher');
    expect(executeMock).toHaveBeenCalled();
  });

  it('surfaces orchestrator errors as a structured failure string', async () => {
    executeMock.mockRejectedValue(new Error('provider down'));
    const handler = createMultiAgentHandler({ agentLoop: {} as never });
    const result = await handler({ task: 'do something' }, {} as never);
    expect(result).toContain('provider down');
  });

  it('rejects an empty task', async () => {
    const handler = createMultiAgentHandler({ agentLoop: {} as never });
    const result = await handler({ task: '   ' }, {} as never);
    expect(result).toContain('No task');
    expect(executeMock).not.toHaveBeenCalled();
  });

  it('forwards agent sequence and maxRounds', async () => {
    executeMock.mockResolvedValue({ status: 'completed', finalOutput: 'ok', totalTurns: 1, handoffs: [], errors: [] });
    const handler = createMultiAgentHandler({ agentLoop: {} as never });
    await handler({ task: 'task', agents: ['researcher', 'writer'], maxRounds: 2 }, {} as never);
    const call = executeMock.mock.calls[0]![1] as { agentSequence?: string[]; maxRounds?: number };
    expect(call.agentSequence).toEqual(['researcher', 'writer']);
    expect(call.maxRounds).toBe(2);
  });

  it('every agent template references only tools that exist in the builtin registry', async () => {
    // Build the real builtin tool name set (same path as registerBuiltinTools).
    const { ToolRegistry } = await import('../ToolRegistry.js');
    const { ToolDispatcher } = await import('../ToolDispatcher.js');
    const { registerBuiltinTools } = await import('../index.js');
    const registry = new ToolRegistry();
    const dispatcher = new ToolDispatcher(registry);
    registerBuiltinTools(registry, dispatcher);
    const realNames = new Set(registry.list().map((t) => t.name));

    const { DEFAULT_AGENT_TEMPLATES } = await import('../../multiagent/MultiAgentOrchestrator.js');
    const missing: string[] = [];
    for (const agent of Object.values(DEFAULT_AGENT_TEMPLATES)) {
      for (const toolName of agent.allowedTools ?? []) {
        if (!realNames.has(toolName)) missing.push(`${agent.id}→${toolName}`);
      }
    }
    expect(missing).toEqual([]);
  }, 15_000);
});
