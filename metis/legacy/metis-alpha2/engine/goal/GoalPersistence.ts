/**
 * GoalPersistence — durable storage boundary for GoalEngine.
 *
 * GoalEngine keeps its goals/plans/runs/archives in memory for execution
 * speed; this interface lets the host (Electron main) back every mutation
 * with a store so goals survive app restarts and provider reconfiguration.
 * Persistence failures never abort engine work — same policy as the
 * autonomous checkpoint store — but the happy path is fully durable.
 */

import type { WorkflowDefinition, WorkflowRun } from '../workflow/types.js';
import type { Goal } from './GoalPlanner.js';
import type { GoalArchive } from './GoalEngine.js';

export interface PersistedGoalState {
  goal: Goal;
  plan: WorkflowDefinition | null;
  run: WorkflowRun | null;
}

export interface GoalPersistence {
  /** Load every persisted goal (with its plan/run) for restart recovery. */
  loadGoals(): PersistedGoalState[];
  /** Load persisted archives. */
  loadArchives(): GoalArchive[];
  saveGoal(goal: Goal): void;
  savePlan(goalId: string, plan: WorkflowDefinition): void;
  saveRun(goalId: string, run: WorkflowRun): void;
  saveArchive(archive: GoalArchive): void;
  deleteGoal(goalId: string): void;
}
