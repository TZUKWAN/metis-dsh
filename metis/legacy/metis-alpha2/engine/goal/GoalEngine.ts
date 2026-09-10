/**
 * GoalEngine — Goal-Driven Plan+Workflow 一体化引擎。
 *
 * 三合一架构：
 *   1. 用户设定 Goal
 *   2. GoalPlanner 自动生成 Plan（WorkflowDefinition）
 *   3. 用户确认/编辑 Plan
 *   4. WorkflowEngine 串行执行
 *   5. 结果汇总 → Goal 完成度更新
 *   6. 记忆归档
 */

import type { WorkflowDefinition, WorkflowRun, WorkflowHooks, WorkflowRunOptions, WorkflowRunControl, WorkflowProjectRulesSnapshot } from '../workflow/types.js';
import { topologicalSort } from '../workflow/types.js';
import type { AgentLoop } from '../core/AgentLoop.js';
import type { ProviderProfileBinding } from '../runtime/ProviderProfileContract.js';
import { WorkflowEngine, findCheckpointResumeStep, hasResumableCheckpoint } from '../workflow/WorkflowEngine.js';
import { GoalPlanner, type Goal, type PlanResult, type ValidationResult } from './GoalPlanner.js';
import type { MemoryManager } from '../memory/MemoryManager.js';
import type { GoalPersistence } from './GoalPersistence.js';

function extractJson(text: string): string {
  const trimmed = text.trim();
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) return trimmed;
  const fenceMatch = trimmed.match(/```(?:json)?\s*([\s\S]*?)\s*```/);
  if (fenceMatch?.[1]) return fenceMatch[1].trim();
  const jsonMatch = trimmed.match(/(\{[\s\S]*\})/);
  if (jsonMatch?.[1]) return jsonMatch[1].trim();
  throw new Error('No JSON object found in response');
}

export interface GoalProgress {
  goalId: string;
  status: Goal['status'];
  totalSteps: number;
  completedSteps: number;
  failedSteps: number;
  currentStepId: string | null;
  startedAt: number;
  completedAt: number | null;
}

export interface GoalArchive {
  goal: Goal;
  workflow: WorkflowDefinition;
  run: WorkflowRun;
  summary: string;
  keyDecisions: string[];
  archivedAt: number;
}

/**
 * O13/O14: goal 执行选项。
 */
export interface GoalExecutionOptions {
  /**
   * O13: 项目覆盖生效时，用另一套 provider 构建的 AgentLoop 执行本次 run。
   * 引擎仅为本次执行构造临时 WorkflowEngine，不影响全局引擎实例。
   */
  agentOverride?: AgentLoop;
  /** O13: 本次运行绑定的 provider profile（解析后的全局/项目覆盖结果）。 */
  providerBinding?: ProviderProfileBinding;
  /** O14: 从持久化 checkpoint 恢复执行（跳过已完成步骤，从失败点续跑）。 */
  resumeFromCheckpoint?: boolean;
  /** Frozen project Metis.md revision for a newly started Goal execution. */
  projectRules?: WorkflowProjectRulesSnapshot;
  /** Cooperative cancellation for one-shot plan generation/refinement. */
  signal?: AbortSignal;
}

/** O14: 目标 checkpoint 状态摘要（供 UI 决定是否显示「从断点继续」）。 */
export interface GoalCheckpointInfo {
  hasCheckpoint: boolean;
  resumable: boolean;
  completedSteps: number;
  totalSteps: number;
  runStatus: WorkflowRun['status'] | null;
}

interface ActiveGoalRun {
  controller: AbortController;
  pauseRequested: boolean;
  cancelRequested: boolean;
  completion: Promise<void>;
  resolveCompletion: () => void;
}

// ─── GoalEngine ───────────────────────────────────────────────

export class GoalEngine {
  private readonly agent: AgentLoop;
  private readonly planner: GoalPlanner;
  private readonly workflowEngine: WorkflowEngine;
  private readonly memoryManager?: MemoryManager;
  private readonly persistence?: GoalPersistence;

  /** Active goals by ID */
  private readonly goals = new Map<string, Goal>();
  /** Once set, no new Goal/Workflow run may be admitted during host shutdown. */
  private shutdownDraining = false;
  /** Plans by goal ID */
  private readonly plans = new Map<string, WorkflowDefinition>();
  /** Runs by goal ID */
  private readonly runs = new Map<string, WorkflowRun>();
  /** Archives */
  private readonly archives: GoalArchive[] = [];
  /** Live-only controls for currently executing Goals. Durable state remains in WorkflowRun. */
  private readonly activeRuns = new Map<string, ActiveGoalRun>();

  constructor(agent: AgentLoop, memoryManager?: MemoryManager, persistence?: GoalPersistence) {
    this.agent = agent;
    this.planner = new GoalPlanner();
    this.workflowEngine = new WorkflowEngine(agent);
    this.memoryManager = memoryManager;
    this.persistence = persistence;
    this.restoreFromPersistence();
  }

  /** Rehydrate goals/plans/runs/archives after a restart or provider swap. */
  private restoreFromPersistence(): void {
    if (!this.persistence) return;
    try {
      for (const state of this.persistence.loadGoals()) {
        const goal = state.goal;
        const run = state.run;
        let normalizedVersion = false;
        if (!Number.isInteger(goal.planVersion) || goal.planVersion < 0) {
          goal.planVersion = state.plan ? 1 : 0;
          normalizedVersion = true;
        }
        if (!Number.isInteger(goal.runVersion) || goal.runVersion < 0) {
          goal.runVersion = Math.max(0, run?.runVersion ?? 0);
          normalizedVersion = true;
        }
        if (run && run.planVersion === undefined) {
          run.planVersion = goal.planVersion;
          normalizedVersion = true;
        }
        if (run && run.runVersion === undefined) {
          run.runVersion = Math.max(1, goal.runVersion);
          goal.runVersion = Math.max(goal.runVersion, run.runVersion);
          normalizedVersion = true;
        }
        // A process restart cannot reconnect an old provider request. Preserve
        // its checkpoint, but expose it as recoverable paused work instead of
        // lying that it is still running.
        const interruptedByRestart = goal.status === 'running' || run?.status === 'running';
        if (interruptedByRestart) {
          goal.status = 'paused';
          if (run?.status === 'running') run.status = 'paused';
          this.persistGoal(goal);
          if (run) this.persistRun(goal.id, run);
        }
        if (normalizedVersion) {
          this.persistGoal(goal);
          if (run) this.persistRun(goal.id, run);
        }
        this.goals.set(goal.id, goal);
        if (state.plan) this.plans.set(goal.id, state.plan);
        if (run) this.runs.set(goal.id, run);
      }
      this.archives.push(...this.persistence.loadArchives());
    } catch (error) {
      // Restore must never prevent the engine from starting; the in-memory
      // engine simply continues without the unreadable history.
      console.warn('[GoalEngine] Persistence restore failed', error);
    }
  }

  private persistGoal(goal: Goal): void {
    try {
      this.persistence?.saveGoal(goal);
    } catch (error) {
      console.warn('[GoalEngine] Goal persistence failed', error);
    }
  }

  private persistPlan(goalId: string, plan: WorkflowDefinition): void {
    try {
      this.persistence?.savePlan(goalId, plan);
    } catch (error) {
      console.warn('[GoalEngine] Plan persistence failed', error);
    }
  }

  private persistRun(goalId: string, run: WorkflowRun): void {
    try {
      this.persistence?.saveRun(goalId, run);
    } catch (error) {
      console.warn('[GoalEngine] Run persistence failed', error);
    }
  }

  private persistArchive(archive: GoalArchive): void {
    try {
      this.persistence?.saveArchive(archive);
    } catch (error) {
      console.warn('[GoalEngine] Archive persistence failed', error);
    }
  }

  private persistDelete(goalId: string): void {
    try {
      this.persistence?.deleteGoal(goalId);
    } catch (error) {
      console.warn('[GoalEngine] Goal deletion persistence failed', error);
    }
  }

  private beginActiveRun(goalId: string): WorkflowRunControl {
    if (this.shutdownDraining) {
      throw new Error('Goal engine is shutting down');
    }
    if (this.activeRuns.has(goalId)) {
      throw new Error(`Goal '${goalId}' is already running`);
    }
    let resolveCompletion!: () => void;
    const completion = new Promise<void>((resolve) => { resolveCompletion = resolve; });
    const active: ActiveGoalRun = {
      controller: new AbortController(),
      pauseRequested: false,
      cancelRequested: false,
      completion,
      resolveCompletion,
    };
    this.activeRuns.set(goalId, active);
    return {
      signal: active.controller.signal,
      getState: () => (
        active.cancelRequested
          ? 'cancel_requested'
          : active.pauseRequested
            ? 'pause_requested'
            : 'running'
      ),
    };
  }

  private endActiveRun(goalId: string, control: WorkflowRunControl): void {
    const active = this.activeRuns.get(goalId);
    if (active?.controller.signal !== control.signal) return;
    this.activeRuns.delete(goalId);
    active.resolveCompletion();
  }

  /** Wait for all in-flight Goal/Workflow promises to unwind after abort. */
  async drainActiveRuns(timeoutMs = 10_000): Promise<{ timedOut: boolean; pending: string[] }> {
    this.shutdownDraining = true;
    const active = [...this.activeRuns.entries()];
    for (const [, run] of active) {
      run.pauseRequested = true;
      run.controller.abort();
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    await Promise.race([
      Promise.allSettled(active.map(([, run]) => run.completion)),
      new Promise<void>((resolve) => {
        timer = setTimeout(() => { timedOut = true; resolve(); }, Math.max(0, timeoutMs));
      }),
    ]);
    if (timer) clearTimeout(timer);
    return { timedOut, pending: [...this.activeRuns.keys()] };
  }

  private async finalizeRun(goalId: string, goal: Goal, run: WorkflowRun): Promise<WorkflowRun> {
    // Cancellation is a terminal user decision. A provider may ignore AbortSignal
    // or resolve after cancelGoal() has already persisted the cancelled state; a
    // late successful result must never resurrect or archive the Goal.
    const active = this.activeRuns.get(goalId);
    const cancellationRequested = goal.status === 'cancelled'
      || active?.cancelRequested === true
      || run.status === 'cancelled';
    if (cancellationRequested && run.status !== 'cancelled') {
      run = {
        ...run,
        status: 'cancelled',
        completedAt: run.completedAt ?? Date.now(),
      };
    }

    this.runs.set(goalId, run);
    this.persistRun(goalId, run);

    if (run.status === 'completed') {
      goal.status = 'completed';
      await this.archiveGoal(goalId);
    } else if (run.status === 'paused') {
      goal.status = 'paused';
    } else if (run.status === 'cancelled') {
      goal.status = 'cancelled';
    } else {
      goal.status = 'failed';
    }
    this.persistGoal(goal);
    return run;
  }

  /** Keep the in-memory map and durable store in lockstep at every Workflow checkpoint. */
  private withPersistenceHooks(goalId: string, hooks?: WorkflowHooks): WorkflowHooks {
    return {
      ...hooks,
      onStepStart: async (step, run) => {
        this.runs.set(goalId, run);
        this.persistRun(goalId, run);
        if (hooks?.onStepStart) await hooks.onStepStart(step, run);
      },
      onStepComplete: async (step, result, run) => {
        this.runs.set(goalId, run);
        this.persistRun(goalId, run);
        if (hooks?.onStepComplete) await hooks.onStepComplete(step, result, run);
      },
      onStepFailed: async (step, result, run) => {
        this.runs.set(goalId, run);
        this.persistRun(goalId, run);
        if (hooks?.onStepFailed) await hooks.onStepFailed(step, result, run);
      },
      onProgress: (completed, total, step) => {
        if (hooks?.onProgress) hooks.onProgress(completed, total, step);
      },
      onCheckpoint: async (run, checkpoint) => {
        this.runs.set(goalId, run);
        this.persistRun(goalId, run);
        if (hooks?.onCheckpoint) await hooks.onCheckpoint(run, checkpoint);
      },
    };
  }

  // ─── Goal Lifecycle ─────────────────────────────────────────

  createGoal(description: string, context?: string, projectId?: string): Goal {
    const goal = GoalPlanner.createGoal(description, context, projectId);
    this.goals.set(goal.id, goal);
    this.persistGoal(goal);
    return goal;
  }

  getGoal(goalId: string): Goal | undefined {
    return this.goals.get(goalId);
  }

  listGoals(): Goal[] {
    return Array.from(this.goals.values()).sort((a, b) => b.createdAt - a.createdAt);
  }

  /** Transition a goal to a new status (kanban column move). */
  setStatus(goalId: string, status: Goal['status']): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    goal.status = status;
    this.persistGoal(goal);
    return true;
  }

  /** Update a goal's priority (kanban card color). */
  setPriority(goalId: string, priority: Goal['priority']): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    goal.priority = priority;
    this.persistGoal(goal);
    return true;
  }

  /** Delete a goal permanently. */
  deleteGoal(goalId: string): boolean {
    const deleted = this.goals.delete(goalId);
    if (!deleted) return false;
    this.plans.delete(goalId);
    this.runs.delete(goalId);
    this.persistDelete(goalId);
    return true;
  }

  // ─── Plan Generation ────────────────────────────────────────

  /**
   * Generate a plan for a goal using the agent.
   * Calls the LLM via AgentLoop to produce a WorkflowDefinition JSON.
   * Falls back to a template workflow if the agent call fails.
   */
  async generatePlan(goalId: string, options?: GoalExecutionOptions): Promise<PlanResult> {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    goal.status = 'planning';
    this.persistGoal(goal);

    const planningPrompt = this.planner.buildPlanningPrompt(goal);

    let workflow: WorkflowDefinition;
    let usedAgent = false;

    try {
      const response = await this.agent.run({
        messages: [
          { role: 'system', content: 'You are a planning assistant. Output ONLY valid JSON matching the WorkflowDefinition schema.' },
          { role: 'user', content: planningPrompt },
        ],
        maxTurns: 1,
        sessionId: `plan-${goalId}`,
        taskContractHash: '',
        promptStackHash: '',
        resumeFromCheckpoint: false,
        requestId: `plan-${goalId}-${Date.now()}`,
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      if (options?.signal?.aborted) throw new Error('Goal plan generation aborted');
      if (response.status === 'completed' && response.finalVerified && response.finalText.trim()) {
        const parsed = JSON.parse(extractJson(response.finalText.trim()));
        workflow = parsed as WorkflowDefinition;
        usedAgent = true;
      } else {
        throw new Error(`Agent returned status '${response.status}' with empty text`);
      }
    } catch (error) {
      if (options?.signal?.aborted) {
        goal.status = 'draft';
        this.persistGoal(goal);
        throw error;
      }
      // Fallback to template workflow if agent fails
      console.warn('[GoalEngine] Agent planning failed; using template fallback', error);
      console.warn('[GoalEngine] planning error:', error instanceof Error ? error.stack : error);
      workflow = this.createTemplateWorkflow(goal);
    }

    // Validate
    const validation = this.planner.validatePlan(workflow);
    if (!validation.valid) {
      goal.status = 'draft';
      throw new Error(`Plan validation failed: ${validation.errors.join(', ')}`);
    }

    // Store plan
    this.plans.set(goalId, workflow);
    goal.status = 'ready';
    goal.planVersion++;
    this.persistPlan(goalId, workflow);
    this.persistGoal(goal);

    return {
      goal,
      workflow,
      reasoning: usedAgent
        ? `Generated ${workflow.steps.length} steps via LLM agent.`
        : `Generated ${workflow.steps.length} steps (template fallback — agent unavailable).`,
    };
  }

  /**
   * Refine a plan based on user feedback.
   * Calls the LLM via AgentLoop to revise the workflow.
   * Falls back to appending a feedback step if the agent call fails.
   */
  async refinePlan(goalId: string, feedback: string, options?: GoalExecutionOptions): Promise<PlanResult> {
    const goal = this.goals.get(goalId);
    const workflow = this.plans.get(goalId);
    if (!goal || !workflow) throw new Error(`Goal '${goalId}' not found or no plan exists`);

    goal.status = 'planning';
    this.persistGoal(goal);

    const refinementPrompt = this.planner.buildRefinementPrompt(workflow, feedback);

    let refined: WorkflowDefinition;
    let usedAgent = false;

    try {
      const response = await this.agent.run({
        messages: [
          { role: 'system', content: 'You are a planning assistant. Output ONLY valid JSON matching the WorkflowDefinition schema. Revise the provided workflow based on user feedback.' },
          { role: 'user', content: refinementPrompt },
        ],
        maxTurns: 1,
        sessionId: `refine-${goalId}`,
        taskContractHash: '',
        promptStackHash: '',
        resumeFromCheckpoint: false,
        requestId: `refine-${goalId}-${Date.now()}`,
        ...(options?.signal ? { signal: options.signal } : {}),
      });

      if (options?.signal?.aborted) throw new Error('Goal plan refinement aborted');
      if (response.status === 'completed' && response.finalVerified && response.finalText.trim()) {
        const parsed = JSON.parse(extractJson(response.finalText.trim()));
        refined = parsed as WorkflowDefinition;
        usedAgent = true;
      } else {
        throw new Error(`Agent returned status '${response.status}' with empty text`);
      }
    } catch (error) {
      if (options?.signal?.aborted) {
        goal.status = 'ready';
        this.persistGoal(goal);
        throw error;
      }
      console.warn('[GoalEngine] Agent refinement failed; using fallback step append');
      const fallbackStepId = `step_refined_${Date.now()}`;
      refined = {
        ...workflow,
        steps: [
          ...workflow.steps,
          {
            id: fallbackStepId,
            name: 'User Feedback Integration',
            description: `Address feedback: ${feedback.slice(0, 100)}`,
            prompt: `Review the previous outputs and apply this feedback: ${feedback}\n\nOutput the revised result.`,
            inputFrom: workflow.steps.length > 0 ? [workflow.steps[workflow.steps.length - 1]!.id] : [],
            tools: [],
            maxTurns: 6,
          },
        ],
        dependencies: {
          ...workflow.dependencies,
          [fallbackStepId]: workflow.steps.length > 0 ? [workflow.steps[workflow.steps.length - 1]!.id] : [],
        },
      };
    }

    this.plans.set(goalId, refined);
    goal.status = 'ready';
    goal.planVersion++;
    this.persistPlan(goalId, refined);
    this.persistGoal(goal);

    return {
      goal,
      workflow: refined,
      reasoning: usedAgent
        ? 'Refined plan via LLM agent.'
        : 'Refined plan with a safe fallback.',
    };
  }

  /**
   * Update a plan directly (user edits).
   */
  updatePlan(goalId: string, workflow: WorkflowDefinition): ValidationResult {
    const goal = this.goals.get(goalId);
    if (!goal) throw new Error(`Goal '${goalId}' not found`);

    const validation = this.planner.validatePlan(workflow);
    if (validation.valid) {
      this.plans.set(goalId, workflow);
      goal.status = 'ready';
      goal.planVersion++;
      this.persistPlan(goalId, workflow);
      this.persistGoal(goal);
    }
    return validation;
  }

  // ─── Execution ──────────────────────────────────────────────

  /**
   * Execute a goal's plan.
   *
   * O13: options.providerBinding 绑定到 run 记录并注入每个步骤请求；
   * options.agentOverride 用于项目级 provider 覆盖（临时执行器）。
   * O14: options.resumeFromCheckpoint 为 true 且存在持久化 run 时，把该 run
   * 作为 checkpoint——已 completed 的步骤结果被搬入并跳过，从失败点续跑。
   */
  async executeGoal(goalId: string, hooks?: WorkflowHooks, options?: GoalExecutionOptions): Promise<WorkflowRun> {
    const goal = this.goals.get(goalId);
    const workflow = this.plans.get(goalId);
    if (!goal || !workflow) throw new Error(`Goal '${goalId}' not found or no plan`);

    const control = this.beginActiveRun(goalId);
    const runVersion = ++goal.runVersion;
    goal.status = 'running';
    this.persistGoal(goal);

    try {
      const enrichedHooks = this.withPersistenceHooks(goalId, hooks);

      // O14: checkpoint 恢复——以上次持久化 run 为 checkpoint，跳过已完成步骤。
      const previousRun = this.runs.get(goalId);
      const useCheckpoint = options?.resumeFromCheckpoint === true
        && previousRun !== undefined
        && hasResumableCheckpoint(workflow, previousRun);
      const runOptions: WorkflowRunOptions = {
        ...(options?.resumeFromCheckpoint ? { resumeFromCheckpoint: true } : {}),
        ...(useCheckpoint ? { checkpointRun: previousRun } : {}),
        ...(options?.providerBinding ? { providerBinding: options.providerBinding } : {}),
        ...(goal.projectId ? { projectId: goal.projectId } : {}),
        goalId,
        planVersion: goal.planVersion,
        runVersion,
        ...(useCheckpoint && previousRun?.projectRules
          ? { projectRules: previousRun.projectRules }
          : options?.projectRules
            ? { projectRules: options.projectRules }
            : {}),
        control,
      };

      // O13: 项目覆盖生效时使用临时执行器；否则沿用全局引擎。
      const engine = options?.agentOverride ? new WorkflowEngine(options.agentOverride) : this.workflowEngine;
      const run = await engine.run(workflow, { goalDescription: goal.description }, enrichedHooks, undefined, runOptions);
      return this.finalizeRun(goalId, goal, run);
    } finally {
      this.endActiveRun(goalId, control);
    }
  }

  /**
   * Resume a paused/failed goal.
   *
   * O14: fromStepId 省略时不再回退到第一步，而是从持久化 run（checkpoint）
   * 推导恢复点——拓扑序中第一个未完成的步骤；已 completed 的步骤由
   * WorkflowEngine.resume 跳过，实现「从上次断点继续」。若 checkpoint 中
   * 所有步骤均已完成，则从头开始（等价于全新执行）。
   */
  async resumeGoal(goalId: string, fromStepId?: string, hooks?: WorkflowHooks, options?: GoalExecutionOptions): Promise<WorkflowRun> {
    const goal = this.goals.get(goalId);
    const workflow = this.plans.get(goalId);
    const pausedRun = this.runs.get(goalId);
    if (!goal || !workflow || !pausedRun) {
      throw new Error(`Goal '${goalId}' not found or not paused`);
    }
    if (goal.status === 'cancelled' || pausedRun.status === 'cancelled') {
      throw new Error(`Goal '${goalId}' was cancelled and cannot be resumed`);
    }
    if (pausedRun.planVersion !== undefined && pausedRun.planVersion !== goal.planVersion) {
      throw new Error(`Goal '${goalId}' plan changed from revision ${pausedRun.planVersion} to ${goal.planVersion}; start a new run instead of resuming a stale checkpoint`);
    }

    const resumeFrom = fromStepId
      ?? pausedRun.currentStepId
      ?? findCheckpointResumeStep(workflow, pausedRun)
      ?? workflow.steps[0]?.id;
    if (!resumeFrom) throw new Error('No step to resume from');
    const control = this.beginActiveRun(goalId);
    const runVersion = ++goal.runVersion;
    goal.status = 'running';
    this.persistGoal(goal);

    // O13/O14: 项目覆盖执行器 + provider 绑定 + 项目作用域，与 executeGoal 一致。
    const runOptions: WorkflowRunOptions = {
      resumeFromCheckpoint: true,
      ...(options?.providerBinding ? { providerBinding: options.providerBinding } : {}),
      ...(goal.projectId ? { projectId: goal.projectId } : {}),
      goalId,
      planVersion: goal.planVersion,
      runVersion,
      ...(pausedRun.projectRules
        ? { projectRules: pausedRun.projectRules }
        : options?.projectRules
          ? { projectRules: options.projectRules }
          : {}),
      control,
    };
    try {
      const engine = options?.agentOverride ? new WorkflowEngine(options.agentOverride) : this.workflowEngine;
      const run = await engine.resume(workflow, pausedRun, resumeFrom, this.withPersistenceHooks(goalId, hooks), undefined, runOptions);
      return this.finalizeRun(goalId, goal, run);
    } finally {
      this.endActiveRun(goalId, control);
    }
  }

  /**
   * O7: resolve a step that escalated to a human decision (decisionRequired).
   *  - retry  : clear the decision flag + failure reasons and re-run the step.
   *  - skip   : mark the step skipped and resume from the next step in topo order.
   *  - stop   : fail the goal entirely.
   * Mirrors mission-control's retry-differently / skip / stop decision queue.
   */
  async resolveStepDecision(
    goalId: string,
    action: 'retry' | 'skip' | 'stop',
    hooks?: WorkflowHooks,
    options?: GoalExecutionOptions,
  ): Promise<WorkflowRun> {
    const goal = this.goals.get(goalId);
    const workflow = this.plans.get(goalId);
    const pausedRun = this.runs.get(goalId);
    if (!goal || !workflow || !pausedRun) {
      throw new Error(`Goal '${goalId}' not found or not paused`);
    }
    const stepId = pausedRun.currentStepId
      ?? Object.values(pausedRun.stepResults).find((r) => r.decisionRequired)?.stepId;
    if (!stepId) throw new Error('No step awaiting decision');

    if (action === 'stop') {
      goal.status = 'failed';
      this.persistGoal(goal);
      const stoppedRun: WorkflowRun = {
        ...pausedRun,
        status: 'failed',
        completedAt: Date.now(),
        currentStepId: null,
      };
      this.runs.set(goalId, stoppedRun);
      this.persistRun(goalId, stoppedRun);
      return stoppedRun;
    }

    if (action === 'skip') {
      // Mark the step skipped, then resume from the next step in topological order.
      const order = topologicalSort(workflow);
      const idx = order.indexOf(stepId);
      const nextStepId = idx >= 0 && idx + 1 < order.length ? order[idx + 1] : undefined;
      const skippedRun: WorkflowRun = {
        ...pausedRun,
        stepResults: {
          ...pausedRun.stepResults,
          [stepId]: {
            ...pausedRun.stepResults[stepId]!,
            status: 'skipped',
            skipReason: 'human_decision',
            decisionRequired: false,
          },
        },
        currentStepId: nextStepId ?? null,
      };
      this.runs.set(goalId, skippedRun);
      if (!nextStepId) {
        // Skipped the last step — the goal is done (with one skipped step).
        skippedRun.status = 'completed';
        skippedRun.completedAt = Date.now();
        goal.status = 'completed';
        this.persistGoal(goal);
        this.persistRun(goalId, skippedRun);
        await this.archiveGoal(goalId);
        return skippedRun;
      }
      this.persistRun(goalId, skippedRun);
      return this.resumeGoal(goalId, nextStepId, hooks, options);
    }

    // action === 'retry': clear the decision flag + failure reasons, resume.
    const clearedRun: WorkflowRun = {
      ...pausedRun,
      stepResults: {
        ...pausedRun.stepResults,
        [stepId]: {
          ...pausedRun.stepResults[stepId]!,
          decisionRequired: false,
          failureReasons: [],
        },
      },
    };
    this.runs.set(goalId, clearedRun);
    this.persistRun(goalId, clearedRun);
    return this.resumeGoal(goalId, stepId, hooks, options);
  }

  /** Request a cooperative pause at the next Workflow step boundary. */
  pauseGoal(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    const active = this.activeRuns.get(goalId);
    if (!goal || !active || goal.status !== 'running') return false;
    active.pauseRequested = true;
    return true;
  }

  /**
   * Cancel a Goal without misclassifying it as a failed research result.
   * An active AgentLoop receives an AbortSignal; non-active persisted work is
   * marked cancelled while keeping its history visible for audit.
   */
  cancelGoal(goalId: string): boolean {
    const goal = this.goals.get(goalId);
    if (!goal) return false;
    if (goal.status === 'completed' || goal.status === 'cancelled') return false;

    const active = this.activeRuns.get(goalId);
    if (active) {
      active.cancelRequested = true;
      active.controller.abort();
    }

    goal.status = 'cancelled';
    this.persistGoal(goal);
    const run = this.runs.get(goalId);
    if (run && run.status !== 'completed') {
      run.status = 'cancelled';
      run.completedAt = Date.now();
      this.persistRun(goalId, run);
    }
    return true;
  }

  /** Abort all in-flight Goals before a provider/runtime replacement. */
  cancelActiveGoals(): void {
    for (const goalId of Array.from(this.activeRuns.keys())) this.cancelGoal(goalId);
  }

  /**
   * Persist a recoverable checkpoint before the host tears down its provider
   * and SQLite store. Unlike provider replacement cancellation, shutdown must
   * leave the Goal resumable after the next application start.
   */
  suspendActiveGoalsForShutdown(): void {
    for (const [goalId, active] of this.activeRuns) {
      active.pauseRequested = true;
      active.controller.abort();
      const goal = this.goals.get(goalId);
      if (goal && goal.status === 'running') {
        goal.status = 'paused';
        this.persistGoal(goal);
      }
      const run = this.runs.get(goalId);
      if (run && run.status !== 'completed' && run.status !== 'cancelled') {
        run.status = 'paused';
        this.persistRun(goalId, run);
      }
    }
  }

  // ─── Progress & Archive ─────────────────────────────────────

  /**
   * O14: 目标 checkpoint 状态摘要。hasCheckpoint 表示存在持久化 run；
   * resumable 表示该 run 至少完成一步且仍有未完成步骤（可从断点继续）。
   */
  getCheckpointInfo(goalId: string): GoalCheckpointInfo {
    const workflow = this.plans.get(goalId);
    const run = this.runs.get(goalId);
    const stepResults = Object.values(run?.stepResults ?? {});
    const completedSteps = stepResults.filter((s) => s.status === 'completed').length;
    const totalSteps = workflow?.steps.length ?? stepResults.length;
    return {
      hasCheckpoint: run !== undefined,
      resumable: workflow !== undefined && hasResumableCheckpoint(workflow, run),
      completedSteps,
      totalSteps,
      runStatus: run?.status ?? null,
    };
  }

  getProgress(goalId: string): GoalProgress | undefined {
    const goal = this.goals.get(goalId);
    const run = this.runs.get(goalId);
    if (!goal) return undefined;

    const steps = Object.values(run?.stepResults ?? {});
    return {
      goalId,
      status: goal.status,
      totalSteps: steps.length,
      completedSteps: steps.filter((s) => s.status === 'completed').length,
      failedSteps: steps.filter((s) => s.status === 'failed').length,
      currentStepId: run?.currentStepId ?? null,
      startedAt: run?.startedAt ?? goal.createdAt,
      completedAt: run?.completedAt ?? null,
    };
  }

  /**
   * O17: 工作流可视化只读视图——返回 goal 的 WorkflowDefinition 与最新 run
   * （可能为空，表示尚未执行）。仅供展示，不做任何拷贝之外的加工；调用方
   * （主进程 IPC 层）负责契约化截断后再发给渲染端。
   */
  getWorkflowView(goalId: string): { workflow: WorkflowDefinition; run: WorkflowRun | undefined } | undefined {
    const workflow = this.plans.get(goalId);
    if (!workflow) return undefined;
    return { workflow, run: this.runs.get(goalId) };
  }

  async archiveGoal(goalId: string): Promise<GoalArchive> {
    const goal = this.goals.get(goalId);
    const workflow = this.plans.get(goalId);
    const run = this.runs.get(goalId);
    if (!goal || !workflow || !run) throw new Error(`Goal '${goalId}' incomplete`);

    // Build summary from step outputs
    const stepOutputs = Object.values(run.stepResults)
      .filter((s) => s.status === 'completed')
      .map((s) => s.output);

    const summary = `Goal: ${goal.description}\n\nResults:\n${stepOutputs.map((o, i) => `${i + 1}. ${o.slice(0, 200)}${o.length > 200 ? '...' : ''}`).join('\n')}`;

    // Extract key decisions from outputs
    const keyDecisions: string[] = [];
    for (const output of stepOutputs) {
      const decisions = output.match(/decision:\s*(.+)/gi);
      if (decisions) {
        keyDecisions.push(...decisions.map((d) => d.replace(/decision:\s*/i, '').trim()));
      }
    }

    const archive: GoalArchive = {
      goal: { ...goal },
      workflow: { ...workflow, steps: [...workflow.steps] },
      run: { ...run, stepResults: { ...run.stepResults } },
      summary,
      keyDecisions,
      archivedAt: Date.now(),
    };

    this.archives.push(archive);
    this.persistArchive(archive);

    // Record key decisions in memory
    if (this.memoryManager && keyDecisions.length > 0) {
      for (const decision of keyDecisions) {
        this.memoryManager.recordKeyDecision(decision, `From goal: ${goal.description}`);
      }
    }

    return archive;
  }

  getArchives(): GoalArchive[] {
    return [...this.archives];
  }

  // ─── Template Workflows ─────────────────────────────────────

  /**
   * Create a template workflow based on goal description keywords.
   * This is a fallback when the agent-based planning is not available.
   */
  private createTemplateWorkflow(goal: Goal): WorkflowDefinition {
    const desc = goal.description.toLowerCase();

    // Literature review workflow
    if (desc.includes('literature') || desc.includes('review') || desc.includes('survey')) {
      return this.literatureReviewWorkflow(goal);
    }

    // Paper analysis workflow
    if (desc.includes('analyze') || desc.includes('analysis') || desc.includes('methodology')) {
      return this.paperAnalysisWorkflow(goal);
    }

    // Writing workflow
    if (desc.includes('write') || desc.includes('draft') || desc.includes('paper')) {
      return this.writingWorkflow(goal);
    }

    // Experiment workflow
    if (desc.includes('experiment') || desc.includes('design') || desc.includes('test')) {
      return this.experimentWorkflow(goal);
    }

    // Generic research workflow
    return this.genericResearchWorkflow(goal);
  }

  private literatureReviewWorkflow(goal: Goal): WorkflowDefinition {
    return {
      id: `wf_lit_${Date.now()}`,
      name: 'Literature Review',
      description: `Systematic literature review for: ${goal.description}`,
      version: '1.0',
      steps: [
        {
          id: 'search',
          name: 'Search Papers',
          description: 'Find relevant papers using keywords from the goal',
          prompt: `Search for academic papers related to: ${goal.description}\n\nReturn a list of 5-10 relevant papers with title, authors, year, and a brief relevance note.`,
          inputFrom: [],
          tools: ['web_search'],
          maxTurns: 6,
        },
        {
          id: 'extract',
          name: 'Extract Key Points',
          description: 'Extract methodology, findings, and limitations from each paper',
          prompt: 'For each paper found in the previous step, extract:\n1. Main methodology\n2. Key findings\n3. Limitations\n\nPapers:\n{{search.output}}',
          inputFrom: ['search'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'compare',
          name: 'Compare Approaches',
          description: 'Compare methodologies and findings across papers',
          prompt: 'Compare the methodologies and findings across all papers. Identify similarities, differences, and trade-offs.\n\nExtracted data:\n{{extract.output}}',
          inputFrom: ['extract'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'gaps',
          name: 'Identify Gaps',
          description: 'Find research gaps and open questions',
          prompt: 'Based on the comparison, identify research gaps, unresolved questions, and opportunities for future work.\n\nComparison:\n{{compare.output}}',
          inputFrom: ['compare'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'write',
          name: 'Write Review',
          description: 'Synthesize findings into a structured literature review',
          prompt: 'Write a structured literature review section including:\n1. Introduction\n2. Methodology overview\n3. Key findings summary\n4. Comparison table\n5. Identified gaps\n6. Conclusion\n\nUse this information:\n{{extract.output}}\n\nComparison:\n{{compare.output}}\n\nGaps:\n{{gaps.output}}',
          inputFrom: ['extract', 'compare', 'gaps'],
          tools: [],
          maxTurns: 6,
        },
      ],
      dependencies: {
        search: [],
        extract: ['search'],
        compare: ['extract'],
        gaps: ['compare'],
        write: ['extract', 'compare', 'gaps'],
      },
    };
  }

  private paperAnalysisWorkflow(goal: Goal): WorkflowDefinition {
    return {
      id: `wf_analysis_${Date.now()}`,
      name: 'Paper Analysis',
      description: `Deep analysis of paper methodology for: ${goal.description}`,
      version: '1.0',
      steps: [
        {
          id: 'identify',
          name: 'Identify Paper',
          description: 'Identify the target paper from the goal description',
          prompt: `Identify the specific paper to analyze based on: ${goal.description}\n\nReturn: title, authors, year, and a brief summary of what the paper is about.`,
          inputFrom: [],
          tools: ['web_search'],
          maxTurns: 6,
        },
        {
          id: 'methodology',
          name: 'Extract Methodology',
          description: 'Extract and summarize the methodology section',
          prompt: 'Extract the methodology from the paper. Include:\n1. Research questions\n2. Data sources\n3. Methods used\n4. Evaluation metrics\n\nPaper info:\n{{identify.output}}',
          inputFrom: ['identify'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'results',
          name: 'Summarize Results',
          description: 'Extract key results and their significance',
          prompt: 'Summarize the key results and their significance. Include quantitative findings where available.\n\nMethodology:\n{{methodology.output}}',
          inputFrom: ['methodology'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'critique',
          name: 'Critical Analysis',
          description: 'Critically evaluate strengths and weaknesses',
          prompt: 'Provide a critical analysis of the paper. Evaluate:\n1. Methodological rigor\n2. Result validity\n3. Generalizability\n4. Limitations\n\nResults:\n{{results.output}}',
          inputFrom: ['results'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'synthesize',
          name: 'Synthesize Analysis',
          description: 'Combine all analyses into a coherent report',
          prompt: 'Write a comprehensive analysis report combining all previous sections. Structure:\n1. Paper overview\n2. Methodology analysis\n3. Results summary\n4. Critical evaluation\n5. Implications\n\nMethodology:\n{{methodology.output}}\n\nResults:\n{{results.output}}\n\nCritique:\n{{critique.output}}',
          inputFrom: ['methodology', 'results', 'critique'],
          tools: [],
          maxTurns: 6,
        },
      ],
      dependencies: {
        identify: [],
        methodology: ['identify'],
        results: ['methodology'],
        critique: ['results'],
        synthesize: ['methodology', 'results', 'critique'],
      },
    };
  }

  private writingWorkflow(goal: Goal): WorkflowDefinition {
    return {
      id: `wf_write_${Date.now()}`,
      name: 'Academic Writing',
      description: `Write academic content for: ${goal.description}`,
      version: '1.0',
      steps: [
        {
          id: 'outline',
          name: 'Create Outline',
          description: 'Generate a structured outline',
          prompt: `Create a detailed outline for: ${goal.description}\n\nInclude sections, subsections, and key points for each.`,
          inputFrom: [],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'intro',
          name: 'Write Introduction',
          description: 'Draft the introduction section',
          prompt: 'Write the introduction based on the outline. Include:\n1. Background\n2. Problem statement\n3. Contributions\n4. Paper structure\n\nOutline:\n{{outline.output}}',
          inputFrom: ['outline'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'body',
          name: 'Write Body Sections',
          description: 'Draft the main content sections',
          prompt: 'Write the main body sections. Follow the outline structure and expand each point with detail.\n\nOutline:\n{{outline.output}}\n\nIntroduction:\n{{intro.output}}',
          inputFrom: ['outline', 'intro'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'conclusion',
          name: 'Write Conclusion',
          description: 'Draft the conclusion and future work',
          prompt: 'Write the conclusion summarizing key contributions and suggesting future work.\n\nBody:\n{{body.output}}',
          inputFrom: ['body'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'polish',
          name: 'Polish Document',
          description: 'Review and polish the full document',
          prompt: 'Review the full document for clarity, coherence, and academic tone. Fix any issues and produce the final version.\n\nIntroduction:\n{{intro.output}}\n\nBody:\n{{body.output}}\n\nConclusion:\n{{conclusion.output}}',
          inputFrom: ['intro', 'body', 'conclusion'],
          tools: [],
          maxTurns: 6,
        },
      ],
      dependencies: {
        outline: [],
        intro: ['outline'],
        body: ['outline', 'intro'],
        conclusion: ['body'],
        polish: ['intro', 'body', 'conclusion'],
      },
    };
  }

  private experimentWorkflow(goal: Goal): WorkflowDefinition {
    return {
      id: `wf_exp_${Date.now()}`,
      name: 'Experiment Design',
      description: `Design and plan experiment for: ${goal.description}`,
      version: '1.0',
      steps: [
        {
          id: 'question',
          name: 'Define Research Question',
          description: 'Clarify the research question and hypotheses',
          prompt: `Define the precise research question and hypotheses for: ${goal.description}\n\nOutput: research question, null hypothesis, alternative hypothesis.`,
          inputFrom: [],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'design',
          name: 'Design Experiment',
          description: 'Design the experimental methodology',
          prompt: 'Design the experiment. Include:\n1. Variables (independent, dependent, controlled)\n2. Experimental conditions\n3. Data collection procedure\n4. Sample size justification\n\nResearch question:\n{{question.output}}',
          inputFrom: ['question'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'metrics',
          name: 'Define Metrics',
          description: 'Define evaluation metrics and success criteria',
          prompt: 'Define clear metrics and success criteria for evaluating the experiment.\n\nDesign:\n{{design.output}}',
          inputFrom: ['design'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'feasibility',
          name: 'Assess Feasibility',
          description: 'Evaluate practical feasibility',
          prompt: 'Assess the feasibility of the experiment. Consider:\n1. Resource requirements\n2. Time estimate\n3. Potential obstacles\n4. Risk mitigation\n\nDesign:\n{{design.output}}\n\nMetrics:\n{{metrics.output}}',
          inputFrom: ['design', 'metrics'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'report',
          name: 'Generate Report',
          description: 'Compile experiment design report',
          prompt: 'Compile a complete experiment design report with all sections.\n\nQuestion:\n{{question.output}}\n\nDesign:\n{{design.output}}\n\nMetrics:\n{{metrics.output}}\n\nFeasibility:\n{{feasibility.output}}',
          inputFrom: ['question', 'design', 'metrics', 'feasibility'],
          tools: [],
          maxTurns: 6,
        },
      ],
      dependencies: {
        question: [],
        design: ['question'],
        metrics: ['design'],
        feasibility: ['design', 'metrics'],
        report: ['question', 'design', 'metrics', 'feasibility'],
      },
    };
  }

  private genericResearchWorkflow(goal: Goal): WorkflowDefinition {
    return {
      id: `wf_generic_${Date.now()}`,
      name: 'Research Task',
      description: `General research workflow for: ${goal.description}`,
      version: '1.0',
      steps: [
        {
          id: 'understand',
          name: 'Understand Goal',
          description: 'Clarify and break down the research goal',
          prompt: `Clarify and break down this research goal: ${goal.description}\n\nOutput: key questions, scope, and approach.`,
          inputFrom: [],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'research',
          name: 'Gather Information',
          description: 'Search and collect relevant information',
          prompt: 'Search for information to answer the key questions identified.\n\nGoal breakdown:\n{{understand.output}}',
          inputFrom: ['understand'],
          tools: ['web_search'],
          maxTurns: 6,
        },
        {
          id: 'analyze',
          name: 'Analyze Findings',
          description: 'Analyze and synthesize collected information',
          prompt: 'Analyze the collected information. Identify patterns, insights, and gaps.\n\nInformation:\n{{research.output}}',
          inputFrom: ['research'],
          tools: [],
          maxTurns: 6,
        },
        {
          id: 'synthesize',
          name: 'Synthesize Results',
          description: 'Combine analyses into coherent output',
          prompt: 'Synthesize all findings into a coherent response or report.\n\nAnalysis:\n{{analyze.output}}',
          inputFrom: ['analyze'],
          tools: [],
          maxTurns: 6,
        },
      ],
      dependencies: {
        understand: [],
        research: ['understand'],
        analyze: ['research'],
        synthesize: ['analyze'],
      },
    };
  }
}
