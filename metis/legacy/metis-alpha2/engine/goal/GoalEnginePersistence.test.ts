/**
 * Tests for GoalEngine durable persistence — goals/plans/runs/archives are
 * written through the GoalPersistence boundary on every mutation and restored
 * when a new engine is constructed (app restart or provider swap).
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GoalEngine } from './GoalEngine.js';
import type { GoalPersistence, PersistedGoalState } from './GoalPersistence.js';
import type { Goal } from './GoalPlanner.js';
import type { WorkflowDefinition, WorkflowRun } from '../workflow/types.js';
import type { GoalArchive } from './GoalEngine.js';
import type { AgentLoop } from '../core/AgentLoop.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';

// ─── In-memory fake persistence (mirrors the sqlite adapter contract) ──

function createMemoryPersistence() {
  const goals = new Map<string, Goal>();
  const plans = new Map<string, WorkflowDefinition>();
  const runs = new Map<string, WorkflowRun>();
  const archives: GoalArchive[] = [];
  const calls: string[] = [];

  const persistence: GoalPersistence = {
    loadGoals(): PersistedGoalState[] {
      calls.push('loadGoals');
      return Array.from(goals.entries()).map(([goalId, goal]) => ({
        goal: structuredClone(goal),
        plan: plans.get(goalId) ? structuredClone(plans.get(goalId)!) : null,
        run: runs.get(goalId) ? structuredClone(runs.get(goalId)!) : null,
      }));
    },
    loadArchives(): GoalArchive[] {
      calls.push('loadArchives');
      return structuredClone(archives);
    },
    saveGoal(goal) {
      calls.push('saveGoal');
      goals.set(goal.id, structuredClone(goal));
    },
    savePlan(goalId, plan) {
      calls.push('savePlan');
      plans.set(goalId, structuredClone(plan));
    },
    saveRun(goalId, run) {
      calls.push('saveRun');
      runs.set(goalId, structuredClone(run));
    },
    saveArchive(archive) {
      calls.push('saveArchive');
      archives.push(structuredClone(archive));
    },
    deleteGoal(goalId) {
      calls.push('deleteGoal');
      goals.delete(goalId);
      plans.delete(goalId);
      runs.delete(goalId);
    },
  };

  return { persistence, goals, plans, runs, archives, calls };
}

function createMockAgentLoop(): AgentLoop {
  return {
    run: vi.fn(async (req: AgentRunRequest): Promise<AgentRunResult> => {
      const isPlanning = req.sessionId.startsWith('plan-');
      const finalText = isPlanning
        ? JSON.stringify({
            id: 'wf_agent',
            name: 'Agent Plan',
            description: 'Agent-generated workflow',
            version: '1.0',
            steps: [
              { id: 's1', name: 'Step 1', description: 'D', prompt: 'P', inputFrom: [], tools: [], maxTurns: 3 },
            ],
            dependencies: { s1: [] },
          })
        : `Result for ${req.sessionId}`;
      return {
        status: 'completed',
        finalText,
        finalVerified: true,
        messages: [{ role: 'assistant', content: finalText }],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        errors: [],
        traceEvents: [],
      } as AgentRunResult;
    }),
  } as unknown as AgentLoop;
}

describe('GoalEngine persistence', () => {
  let agent: AgentLoop;
  let memory: ReturnType<typeof createMemoryPersistence>;

  beforeEach(() => {
    agent = createMockAgentLoop();
    memory = createMemoryPersistence();
  });

  it('persists a newly created goal and restores it in a fresh engine', () => {
    const engine = new GoalEngine(agent, undefined, memory.persistence);
    const goal = engine.createGoal('Persistent research task');

    expect(memory.goals.get(goal.id)?.description).toBe('Persistent research task');
    expect(memory.calls).toContain('saveGoal');

    const restored = new GoalEngine(agent, undefined, memory.persistence);
    expect(restored.getGoal(goal.id)?.description).toBe('Persistent research task');
    expect(restored.getGoal(goal.id)?.status).toBe('draft');
  });

  it('persists priority and restores an interrupted running goal as recoverable paused work', () => {
    const engine = new GoalEngine(agent, undefined, memory.persistence);
    const goal = engine.createGoal('Move me on the board');

    expect(engine.setStatus(goal.id, 'running')).toBe(true);
    expect(engine.setPriority(goal.id, 'urgent')).toBe(true);
    expect(engine.setStatus('missing', 'running')).toBe(false);

    const restored = new GoalEngine(agent, undefined, memory.persistence);
    // A process restart cannot reconnect an in-flight provider request. The
    // durable checkpoint remains, but the visible state must be resumable
    // rather than falsely claiming that execution is still running.
    expect(restored.getGoal(goal.id)?.status).toBe('paused');
    expect(restored.getGoal(goal.id)?.priority).toBe('urgent');
  });

  it('persists the generated plan so a restarted engine can continue', async () => {
    const engine = new GoalEngine(agent, undefined, memory.persistence);
    const goal = engine.createGoal('Write a literature review');
    await engine.generatePlan(goal.id);

    expect(memory.plans.get(goal.id)).toBeDefined();
    expect(memory.goals.get(goal.id)?.status).toBe('ready');

    const restored = new GoalEngine(agent, undefined, memory.persistence);
    const restoredGoal = restored.getGoal(goal.id)!;
    expect(restoredGoal.status).toBe('ready');
    // Plan is restored too: the board card can show steps after restart.
    const planResult = await restored.generatePlan(goal.id);
    expect(planResult.workflow.steps.length).toBeGreaterThan(0);
  });

  it('persists run progress and auto-archives on completion', async () => {
    const engine = new GoalEngine(agent, undefined, memory.persistence);
    const goal = engine.createGoal('Execute and archive me');
    await engine.generatePlan(goal.id);
    const run = await engine.executeGoal(goal.id);

    expect(run.status).toBe('completed');
    expect(memory.runs.get(goal.id)?.status).toBe('completed');
    expect(memory.goals.get(goal.id)?.status).toBe('completed');
    expect(memory.archives.some((a) => a.goal.id === goal.id)).toBe(true);

    const restored = new GoalEngine(agent, undefined, memory.persistence);
    expect(restored.getGoal(goal.id)?.status).toBe('completed');
    expect(restored.getArchives().some((a) => a.goal.id === goal.id)).toBe(true);
  });

  it('cleans persisted rows when a goal is deleted', () => {
    const engine = new GoalEngine(agent, undefined, memory.persistence);
    const goal = engine.createGoal('Delete me');
    engine.setStatus(goal.id, 'running');
    expect(memory.goals.size).toBe(1);

    expect(engine.deleteGoal(goal.id)).toBe(true);
    expect(memory.goals.size).toBe(0);
    expect(memory.plans.size).toBe(0);
    expect(memory.runs.size).toBe(0);
    expect(memory.calls).toContain('deleteGoal');

    // A restarted engine must not resurrect the deleted goal.
    const restored = new GoalEngine(agent, undefined, memory.persistence);
    expect(restored.getGoal(goal.id)).toBeUndefined();
  });

  it('keeps archives after deleteGoal so history survives', async () => {
    const engine = new GoalEngine(agent, undefined, memory.persistence);
    const goal = engine.createGoal('Keep my history');
    await engine.generatePlan(goal.id);
    await engine.executeGoal(goal.id);

    engine.deleteGoal(goal.id);
    const restored = new GoalEngine(agent, undefined, memory.persistence);
    expect(restored.getGoal(goal.id)).toBeUndefined();
    expect(restored.getArchives().some((a) => a.goal.id === goal.id)).toBe(true);
  });

  it('starts cleanly when persistence restore fails (never blocks the engine)', () => {
    const broken: GoalPersistence = {
      loadGoals: () => { throw new Error('disk read failed'); },
      loadArchives: () => { throw new Error('disk read failed'); },
      saveGoal: () => {},
      savePlan: () => {},
      saveRun: () => {},
      saveArchive: () => {},
      deleteGoal: () => {},
    };
    const engine = new GoalEngine(agent, undefined, broken);
    const goal = engine.createGoal('Still works');
    expect(engine.getGoal(goal.id)?.description).toBe('Still works');
  });

  it('does not persist when no persistence is configured (legacy behavior)', () => {
    const engine = new GoalEngine(agent);
    engine.createGoal('No store attached');
    expect(memory.calls).not.toContain('saveGoal');
  });
});
