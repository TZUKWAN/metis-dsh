/**
 * GoalPersistenceStore integration tests — the real sqlite-backed adapter must
 * persist goals/plans/runs/archives and restore them into a fresh engine,
 * exactly like an app restart or provider swap does.
 */

import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { createGoalPersistence } from '../../electron/GoalPersistenceStore.js';
import { GoalEngine } from '../../engine/goal/GoalEngine.js';
import type { AgentLoop } from '../../engine/core/AgentLoop.js';
import type { AgentRunRequest, AgentRunResult } from '../../engine/core/types.js';

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

describe('GoalPersistenceStore (sqlite)', () => {
  let root: string;
  let dbPath: string;

  beforeEach(() => {
    root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-goal-store-'));
    dbPath = path.join(root, 'goals.db');
  });

  afterEach(() => {
    fs.rmSync(root, { recursive: true, force: true });
  });

  it('survives a full app restart: create → plan → execute → reopen', async () => {
    const agent = createMockAgentLoop();
    const store = new PersistenceStore(dbPath);
    const engine = new GoalEngine(agent, undefined, createGoalPersistence(store));
    const goal = engine.createGoal('Restart-proof research task');
    await engine.generatePlan(goal.id);
    const run = await engine.executeGoal(goal.id);
    expect(run.status).toBe('completed');
    // A completed goal auto-archives.
    store.close();
    void store;

    // "Restart": fresh sqlite handle + fresh engine over the same file.
    const restartedStore = new PersistenceStore(dbPath);
    const restarted = new GoalEngine(agent, undefined, createGoalPersistence(restartedStore));
    const restored = restarted.getGoal(goal.id);
    expect(restored?.description).toBe('Restart-proof research task');
    expect(restored?.status).toBe('completed');
    expect(restarted.getArchives().some((a) => a.goal.id === goal.id)).toBe(true);
    restartedStore.close();
  });

  it('normalizes an orphaned running goal to a recoverable paused state after a provider swap', async () => {
    const store = new PersistenceStore(dbPath);
    const persistence = createGoalPersistence(store);

    const agent = createMockAgentLoop();
    const engine = new GoalEngine(agent, undefined, persistence);
    const goal = engine.createGoal('Swap-safe goal');
    engine.setStatus(goal.id, 'running');
    engine.setPriority(goal.id, 'urgent');

    // Provider reconfiguration constructs a brand new engine over the same store.
    const swapped = new GoalEngine(createMockAgentLoop(), undefined, createGoalPersistence(store));
    expect(swapped.getGoal(goal.id)?.status).toBe('paused');
    expect(swapped.getGoal(goal.id)?.priority).toBe('urgent');
    store.close();
  });

  it('does not resurrect deleted goals across restarts', () => {
    const store = new PersistenceStore(dbPath);
    const engine = new GoalEngine(createMockAgentLoop(), undefined, createGoalPersistence(store));
    const goal = engine.createGoal('Delete forever');
    engine.deleteGoal(goal.id);

    const restarted = new GoalEngine(createMockAgentLoop(), undefined, createGoalPersistence(store));
    expect(restarted.getGoal(goal.id)).toBeUndefined();
    store.close();
  });

  it('skips corrupted rows instead of failing the whole restore', () => {
    const store = new PersistenceStore(dbPath);
    // Inject a corrupt goal row the way the adapter reads it back.
    store.setMemory('g:goal_corrupt', '{not valid json', 'goal_engine');
    store.setMemory('g:goal_ok', JSON.stringify({
      id: 'goal_ok',
      description: 'Healthy goal',
      createdAt: 1,
      status: 'draft',
    }), 'goal_engine');

    const engine = new GoalEngine(createMockAgentLoop(), undefined, createGoalPersistence(store));
    expect(engine.getGoal('goal_corrupt')).toBeUndefined();
    expect(engine.getGoal('goal_ok')?.description).toBe('Healthy goal');
    store.close();
  });
});
