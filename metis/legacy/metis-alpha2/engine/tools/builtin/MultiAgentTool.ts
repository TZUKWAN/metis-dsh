/**
 * Multi-agent orchestration tool — exposes MultiAgentOrchestrator to the agent
 * runtime so a chat agent can delegate a task to a coordinated sequence of
 * specialist agents (researcher → writer → reviewer by default).
 *
 * Activates the previously-experimental engine/multiagent module by wrapping
 * it in a ToolSpec/handler pair registered with the builtin tool set. The
 * handler resolves the active AgentLoop from the tool context (injected by the
 * main process at registration time) and runs the orchestrator; it serializes
 * the final output and a short summary of agent contributions to a string.
 */

import type { ToolSpec } from '../../core/types.js';
import type { ToolHandler } from '../ToolDispatcher.js';
import type { AgentLoop } from '../../core/AgentLoop.js';

export const MULTI_AGENT_TOOL: ToolSpec = {
  name: 'multi_agent_orchestrate',
  description: 'Delegate a research or writing task to a coordinated sequence of specialist agents (researcher, writer, reviewer, coordinator). Use for complex, multi-step tasks that benefit from role specialization and review. Returns the synthesized final output plus a per-agent summary.',
  parameters: {
    type: 'object',
    properties: {
      task: { type: 'string', description: 'The task to delegate to the multi-agent team' },
      agents: {
        type: 'array',
        items: { type: 'string' },
        description: 'Ordered agent roles to run. Defaults to ["coordinator","researcher","writer","reviewer"].',
      },
      maxRounds: { type: 'number', description: 'Maximum collaboration rounds (default 3)' },
    },
    required: ['task'],
  },
};

export interface MultiAgentToolContext {
  agentLoop: AgentLoop;
}

export function createMultiAgentHandler(context: MultiAgentToolContext): ToolHandler {
  return async (args: Record<string, unknown>) => {
    const task = String(args.task ?? '').trim();
    if (!task) return 'Error: No task provided for multi-agent orchestration.';
    const agents = Array.isArray(args.agents) ? (args.agents as unknown[]).map(String) : undefined;
    const maxRounds = typeof args.maxRounds === 'number' ? Math.min(Math.max(args.maxRounds, 1), 6) : 3;

    try {
      const { MultiAgentOrchestrator } = await import('../../multiagent/MultiAgentOrchestrator.js');
      const orchestrator = new MultiAgentOrchestrator(context.agentLoop);
      const result = await orchestrator.execute(task, {
        agentSequence: agents,
        maxRounds,
      });
      const lines: string[] = [];
      lines.push(`Multi-agent orchestration finished: ${result.status}`);
      lines.push(`Total turns across agents: ${result.totalTurns}`);
      if (result.errors.length > 0) {
        lines.push(`Errors: ${result.errors.join('; ')}`);
      }
      lines.push('', '--- Final output ---', result.finalOutput || '(no output)');
      if (result.handoffs.length > 0) {
        lines.push('', `Handoffs: ${result.handoffs.length} (sequence: ${result.handoffs.map((h) => h.from + '→' + h.to).join(', ')})`);
      }
      return lines.join('\n');
    } catch (err) {
      return `Multi-agent orchestration failed: ${err instanceof Error ? err.message : String(err)}`;
    }
  };
}
