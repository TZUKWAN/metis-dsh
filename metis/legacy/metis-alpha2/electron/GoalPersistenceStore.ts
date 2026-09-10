/**
 * GoalPersistenceStore — PersistenceStore-backed GoalPersistence adapter.
 *
 * Goals/plans/runs/archives are JSON-serialized into the shared `memory`
 * table under the `goal_engine` category (same pattern as the autonomous
 * checkpoint store), so backups and restores cover them too. Keys are
 * namespaced by kind: g:/p:/r:/a: + goalId.
 */

import type { GoalPersistence, PersistedGoalState } from '../engine/goal/GoalPersistence.js';
import type { GoalArchive } from '../engine/goal/GoalEngine.js';
import type { Goal } from '../engine/goal/GoalPlanner.js';
import type { WorkflowDefinition, WorkflowRun } from '../engine/workflow/types.js';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';

const CATEGORY = 'goal_engine';
const GOAL_PREFIX = 'g:';
const PLAN_PREFIX = 'p:';
const RUN_PREFIX = 'r:';
const ARCHIVE_PREFIX = 'a:';

function parseJson<T>(value: string): T | undefined {
  try {
    return JSON.parse(value) as T;
  } catch {
    return undefined;
  }
}

export function createGoalPersistence(store: PersistenceStore): GoalPersistence {
  const entries = () => store.getMemoryByCategory(CATEGORY);

  const loadGoals = (): PersistedGoalState[] => {
    const states = new Map<string, PersistedGoalState>();
    for (const entry of entries()) {
      if (!entry.key.startsWith(GOAL_PREFIX)) continue;
      const goal = parseJson<Goal>(entry.value);
      if (!goal?.id) continue;
      states.set(goal.id, { goal, plan: null, run: null });
    }
    for (const entry of entries()) {
      if (entry.key.startsWith(PLAN_PREFIX)) {
        const goalId = entry.key.slice(PLAN_PREFIX.length);
        const state = states.get(goalId);
        const plan = parseJson<WorkflowDefinition>(entry.value);
        if (state && plan) state.plan = plan;
      } else if (entry.key.startsWith(RUN_PREFIX)) {
        const goalId = entry.key.slice(RUN_PREFIX.length);
        const state = states.get(goalId);
        const run = parseJson<WorkflowRun>(entry.value);
        if (state && run) state.run = run;
      }
    }
    return Array.from(states.values());
  };

  const loadArchives = (): GoalArchive[] => {
    const archives: GoalArchive[] = [];
    for (const entry of entries()) {
      if (!entry.key.startsWith(ARCHIVE_PREFIX)) continue;
      const archive = parseJson<GoalArchive>(entry.value);
      if (archive?.goal?.id) archives.push(archive);
    }
    return archives.sort((a, b) => b.archivedAt - a.archivedAt);
  };

  return {
    loadGoals,
    loadArchives,
    saveGoal(goal) {
      store.setMemory(`${GOAL_PREFIX}${goal.id}`, JSON.stringify(goal), CATEGORY);
    },
    savePlan(goalId, plan) {
      store.setMemory(`${PLAN_PREFIX}${goalId}`, JSON.stringify(plan), CATEGORY);
    },
    saveRun(goalId, run) {
      store.setMemory(`${RUN_PREFIX}${goalId}`, JSON.stringify(run), CATEGORY);
    },
    saveArchive(archive) {
      store.setMemory(`${ARCHIVE_PREFIX}${archive.goal.id}`, JSON.stringify(archive), CATEGORY);
    },
    deleteGoal(goalId) {
      store.deleteMemory(`${GOAL_PREFIX}${goalId}`);
      store.deleteMemory(`${PLAN_PREFIX}${goalId}`);
      store.deleteMemory(`${RUN_PREFIX}${goalId}`);
    },
  };
}
