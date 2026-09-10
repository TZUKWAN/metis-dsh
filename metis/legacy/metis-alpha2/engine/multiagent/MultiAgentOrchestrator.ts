/**
 * Multi-Agent Orchestrator — collaborative agent architecture.
 *
 * STATUS: WIRED via multi_agent_orchestrate tool.
 * This module is activated as a builtin tool (engine/tools/builtin/MultiAgentTool)
 * so the chat agent can delegate tasks to a coordinated specialist sequence.
 * The production scenario runtime (ScenarioRunCoordinator) drives multi-step
 * workflows directly; this orchestrator is an alternative for ad-hoc
 * multi-agent delegation from a chat turn.
 *
 * Enables multiple specialized agents to collaborate on research tasks.
 * Agents communicate through a shared message bus and coordinated by the orchestrator.
 *
 * Key concepts:
 *   - AgentRole: Each agent has a specialized role (researcher, writer, reviewer, etc.)
 *   - Handoff: Agents can hand off tasks to other agents
 *   - Shared context: All agents share a common workspace and message history
 *   - Orchestration: The orchestrator manages agent lifecycle, routing, and convergence
 */

import type { AgentLoop } from '../core/AgentLoop.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';
import { HookBus, type HookContext } from '../core/HookBus.js';

// ─── Agent Role ─────────────────────────────────────────────────

export type AgentRole = 'researcher' | 'writer' | 'reviewer' | 'analyst' | 'coordinator';

export interface AgentDefinition {
  /** Unique agent identifier. */
  id: string;
  /** Agent's specialized role. */
  role: AgentRole;
  /** System prompt that defines the agent's behavior. */
  systemPrompt: string;
  /** Tools this agent is allowed to use. */
  allowedTools?: string[];
  /** Maximum turns for this agent's execution. */
  maxTurns?: number;
  /** Description of what this agent does (for logging/display). */
  description: string;
}

// ─── Handoff Protocol ────────────────────────────────────────────

export interface HandoffMessage {
  from: string;
  to: string;
  content: string;
  /** What kind of handoff this is. */
  type: 'task' | 'feedback' | 'result' | 'question';
  /** Priority of the handoff (lower = higher priority). */
  priority: number;
  /** Additional context to pass. */
  context?: Record<string, unknown>;
}

// ─── Orchestrator State ──────────────────────────────────────────

export type OrchestratorStatus = 'idle' | 'running' | 'paused' | 'completed' | 'error';

export interface OrchestratorResult {
  status: OrchestratorStatus;
  /** Final output from the orchestrator. */
  finalOutput: string;
  /** Messages from all agents, interleaved. */
  conversationLog: Array<{
    agentId: string;
    role: AgentRole;
    message: string;
    timestamp: number;
  }>;
  /** Results from each agent's execution. */
  agentResults: Map<string, AgentRunResult[]>;
  /** Total turns used across all agents. */
  totalTurns: number;
  /** Handoffs that occurred. */
  handoffs: HandoffMessage[];
  /** Errors encountered. */
  errors: string[];
}

// ─── Default Agent Templates ─────────────────────────────────────

export const DEFAULT_AGENT_TEMPLATES: Record<string, AgentDefinition> = {
  researcher: {
    id: 'researcher',
    role: 'researcher',
    systemPrompt: `You are a research agent. Your job is to:
1. Search for relevant papers and information
2. Extract key findings and methodologies
3. Identify research gaps and opportunities
4. Compile comprehensive literature summaries

Focus on thoroughness and accuracy. Always cite your sources.
Use arxiv_search, search_papers, rag_search and read_pdf tools to gather information.`,
    allowedTools: ['arxiv_search', 'read_pdf', 'parse_bibtex', 'search_papers', 'rag_search'],
    maxTurns: 15,
    description: 'Searches and analyzes academic literature',
  },
  writer: {
    id: 'writer',
    role: 'writer',
    systemPrompt: `You are a writing agent. Your job is to:
1. Structure research findings into coherent prose
2. Write clear, academic-style text
3. Format citations properly
4. Create well-organized sections (Introduction, Methods, Results, Discussion)

Focus on clarity, flow, and academic rigor.
Use format_citation tool for proper citation formatting.`,
    allowedTools: ['format_citation', 'write_file'],
    maxTurns: 12,
    description: 'Writes and structures academic content',
  },
  reviewer: {
    id: 'reviewer',
    role: 'reviewer',
    systemPrompt: `You are a peer review agent. Your job is to:
1. Evaluate the quality and rigor of written content
2. Identify weaknesses, gaps, and inconsistencies
3. Suggest improvements and corrections
4. Rate the work on clarity, methodology, contribution, and presentation

Be constructive but thorough. Provide specific, actionable feedback.
Structure your review as: Summary, Strengths, Weaknesses, Questions, Rating.`,
    maxTurns: 8,
    description: 'Reviews and critiques academic content',
  },
  analyst: {
    id: 'analyst',
    role: 'analyst',
    systemPrompt: `You are a data analysis agent. Your job is to:
1. Design experiments and data collection strategies
2. Analyze experimental results
3. Create visualizations and summaries
4. Interpret statistical findings

Focus on statistical rigor and clear presentation of results.`,
    allowedTools: ['read_file', 'write_file'],
    maxTurns: 10,
    description: 'Designs experiments and analyzes data',
  },
  coordinator: {
    id: 'coordinator',
    role: 'coordinator',
    systemPrompt: `You are the coordinator agent. Your job is to:
1. Break down complex research tasks into subtasks
2. Assign subtasks to the appropriate specialist agents
3. Synthesize results from multiple agents
4. Ensure the overall task is completed coherently

You decide which agent should work on which part of the task.
Hand off work to the appropriate specialist when needed.`,
    maxTurns: 5,
    description: 'Coordinates multi-agent collaboration',
  },
};

// ─── Multi-Agent Orchestrator ────────────────────────────────────

export class MultiAgentOrchestrator {
  private readonly agentLoop: AgentLoop;
  private readonly hooks: HookBus;
  private readonly agents = new Map<string, AgentDefinition>();
  private status: OrchestratorStatus = 'idle';

  constructor(agentLoop: AgentLoop, hooks?: HookBus) {
    this.agentLoop = agentLoop;
    this.hooks = hooks ?? new HookBus();

    // Register default agent templates
    for (const [key, template] of Object.entries(DEFAULT_AGENT_TEMPLATES)) {
      this.agents.set(key, template);
    }
  }

  /** Register or override an agent definition. */
  registerAgent(definition: AgentDefinition): void {
    this.agents.set(definition.id, definition);
  }

  /** Get all registered agent definitions. */
  listAgents(): AgentDefinition[] {
    return [...this.agents.values()];
  }

  /** Current orchestrator status. */
  getStatus(): OrchestratorStatus {
    return this.status;
  }

  /**
   * Execute a collaborative multi-agent task.
   *
   * The orchestrator runs agents in sequence, each building on the previous
   * agent's output. The flow is:
   *   1. Coordinator analyzes the task and creates a plan
   *   2. Researcher gathers information (if needed)
   *   3. Writer drafts content (if needed)
   *   4. Reviewer provides feedback (if needed)
   *   5. Writer revises based on feedback
   *   6. Coordinator synthesizes final output
   */
  async execute(
    task: string,
    options?: {
      agentSequence?: string[];
      sessionId?: string;
      maxRounds?: number;
      context?: Record<string, unknown>;
    },
  ): Promise<OrchestratorResult> {
    this.status = 'running';
    const sessionId = options?.sessionId ?? `ma-${Date.now()}`;
    const maxRounds = options?.maxRounds ?? 3;

    const conversationLog: OrchestratorResult['conversationLog'] = [];
    const agentResults = new Map<string, AgentRunResult[]>();
    const handoffs: HandoffMessage[] = [];
    const errors: string[] = [];
    let totalTurns = 0;

    await this.hooks.emitAsync('multiagent.start', { sessionId, task } as unknown as HookContext);

    // Determine agent sequence
    const sequence = options?.agentSequence ?? ['coordinator', 'researcher', 'writer', 'reviewer'];

    // Build shared context that accumulates across agents
    let sharedContext = `# Research Task\n${task}\n\n`;
    if (options?.context) {
      sharedContext += `## Additional Context\n${JSON.stringify(options.context, null, 2)}\n\n`;
    }

    for (let round = 0; round < maxRounds; round++) {
      for (const agentId of sequence) {
        const agent = this.agents.get(agentId);
        if (!agent) {
          errors.push(`Agent '${agentId}' not found, skipping`);
          continue;
        }

        const roundLabel = round > 0 ? ` (Round ${round + 1})` : '';
        const prompt = `${sharedContext}\n---\nYou are the ${agent.role} agent. ${agent.description}${roundLabel}\n\n${agent.systemPrompt}\n\n## Your Turn\nPlease perform your role based on the context above.`;

        const request: AgentRunRequest = {
          sessionId: `${sessionId}-${agentId}-r${round}`,
          messages: [
            { role: 'system', content: agent.systemPrompt },
            { role: 'user', content: prompt },
          ],
          allowedTools: agent.allowedTools,
          maxTurns: agent.maxTurns ?? 12,
          taskContractHash: '',
          promptStackHash: '',
          resumeFromCheckpoint: false,
          requestId: `ma-${agentId}-${Date.now()}`,
        };

        try {
          const result = await this.agentLoop.run(request);
          totalTurns += result.turnsUsed;

          // Store results
          const existing = agentResults.get(agentId) ?? [];
          existing.push(result);
          agentResults.set(agentId, existing);

          conversationLog.push({
            agentId,
            role: agent.role,
            message: result.finalText,
            timestamp: Date.now(),
          });

          // Add agent's output to shared context
          sharedContext += `## ${agent.role.charAt(0).toUpperCase() + agent.role.slice(1)} Agent Output\n${result.finalText}\n\n`;

          // Record handoff to next agent
          const nextIdx = sequence.indexOf(agentId) + 1;
          if (nextIdx < sequence.length) {
            handoffs.push({
              from: agentId,
              to: sequence[nextIdx]!,
              content: result.finalText.slice(0, 200),
              type: 'result',
              priority: 10,
            });
          }

          await this.hooks.emitAsync('multiagent.agent_complete', {
            sessionId,
            agentId,
            role: agent.role,
            status: result.status,
            turns: result.turnsUsed,
          } as unknown as HookContext);

          // Early exit if completed successfully after reviewer in round > 0
          if (agent.role === 'reviewer' && round > 0 && result.status === 'completed') {
            this.status = 'completed';
            return this.buildResult('completed', sharedContext, conversationLog, agentResults, totalTurns, handoffs, errors);
          }
        } catch (err) {
          const errMsg = err instanceof Error ? err.message : String(err);
          errors.push(`Agent '${agentId}' failed: ${errMsg}`);
        }
      }
    }

    this.status = 'completed';
    return this.buildResult('completed', sharedContext, conversationLog, agentResults, totalTurns, handoffs, errors);
  }

  /**
   * Execute multiple independent agents in parallel.
   * Each agent runs on the same task with its own context.
   * Results are merged after all agents complete.
   * Useful when researcher + analyst can work simultaneously.
   */
  async executeParallel(
    task: string,
    agentIds: string[],
    options?: {
      sessionId?: string;
      context?: Record<string, unknown>;
    },
  ): Promise<OrchestratorResult> {
    this.status = 'running';
    const sessionId = options?.sessionId ?? `ma-par-${Date.now()}`;
    const conversationLog: OrchestratorResult['conversationLog'] = [];
    const agentResults = new Map<string, AgentRunResult[]>();
    const handoffs: HandoffMessage[] = [];
    const errors: string[] = [];

    await this.hooks.emitAsync('multiagent.start', { sessionId, task } as unknown as HookContext);

    const sharedContext = task;

    // Run all agents in parallel
    const promises = agentIds.map(async (agentId) => {
      const agent = this.agents.get(agentId);
      if (!agent) {
        errors.push(`Agent '${agentId}' not found`);
        return null;
      }

      const prompt = `${sharedContext}\n---\nYou are the ${agent.role} agent. ${agent.description}\n\n${agent.systemPrompt}\n\n## Your Turn\nPerform your role based on the context above.`;

      const request: AgentRunRequest = {
        sessionId: `${sessionId}-${agentId}`,
        messages: [
          { role: 'system', content: agent.systemPrompt },
          { role: 'user', content: prompt },
        ],
        allowedTools: agent.allowedTools,
        maxTurns: agent.maxTurns ?? 12,
        taskContractHash: '',
        promptStackHash: '',
        resumeFromCheckpoint: false,
        requestId: `ma-par-${agentId}-${Date.now()}`,
      };

      try {
        const result = await this.agentLoop.run(request);
        return { agentId, agent, result };
      } catch (err) {
        errors.push(`Agent '${agentId}' failed: ${err instanceof Error ? err.message : String(err)}`);
        return null;
      }
    });

    const results = await Promise.all(promises);
    let totalTurns = 0;

    for (const r of results) {
      if (!r) continue;
      const existing = agentResults.get(r.agentId) ?? [];
      existing.push(r.result);
      agentResults.set(r.agentId, existing);
      totalTurns += r.result.turnsUsed;

      conversationLog.push({
        agentId: r.agentId,
        role: r.agent.role,
        message: r.result.finalText,
        timestamp: Date.now(),
      });

      // Create handoff entries for cross-agent sharing
      for (const other of results) {
        if (!other || other.agentId === r.agentId) continue;
        handoffs.push({
          from: r.agentId,
          to: other.agentId,
          content: r.result.finalText.slice(0, 200),
          type: 'result',
          priority: 10,
        });
      }
    }

    this.status = 'completed';

    // Build merged output
    const mergedOutput = conversationLog
      .map((log) => `## ${log.role} Agent\n${log.message}`)
      .join('\n\n---\n\n');

    return this.buildResult('completed', mergedOutput, conversationLog, agentResults, totalTurns, handoffs, errors);
  }

  /**
   * Execute a single agent for a focused task.
   */
  async executeSingle(
    agentId: string,
    task: string,
    sessionId?: string,
  ): Promise<AgentRunResult> {
    const agent = this.agents.get(agentId);
    if (!agent) throw new Error(`Agent '${agentId}' not registered`);

    const request: AgentRunRequest = {
      sessionId: sessionId ?? `ma-${agentId}-${Date.now()}`,
      messages: [
        { role: 'system', content: agent.systemPrompt },
        { role: 'user', content: task },
      ],
      allowedTools: agent.allowedTools,
      maxTurns: agent.maxTurns ?? 12,
      taskContractHash: '',
      promptStackHash: '',
      resumeFromCheckpoint: false,
      requestId: `ma-single-${agentId}-${Date.now()}`,
    };

    return this.agentLoop.run(request);
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private buildResult(
    status: OrchestratorStatus,
    finalOutput: string,
    conversationLog: OrchestratorResult['conversationLog'],
    agentResults: Map<string, AgentRunResult[]>,
    totalTurns: number,
    handoffs: HandoffMessage[],
    errors: string[],
  ): OrchestratorResult {
    return {
      status,
      finalOutput,
      conversationLog,
      agentResults,
      totalTurns,
      handoffs,
      errors,
    };
  }
}
