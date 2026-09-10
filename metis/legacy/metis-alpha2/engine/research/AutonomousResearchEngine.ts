/**
 * AutonomousResearchEngine — the while-not-done scheduler that drives the
 * autonomous research loop.
 *
 * Responsibilities:
 *   - Walk the planner's plan one phase at a time.
 *   - Execute each phase through WorkflowEngine (which runs the phase's steps
 *     against the real AgentLoop + tools), forwarding step events to the bus.
 *   - Check the live-steering queue between phases for pause/interrupt.
 *   - Reflect after each phase; redo/rollback/advance/done per the planner.
 *   - Persist phase checkpoints so a crashed/resumed session can continue.
 *
 * The engine owns NO agent state itself — it composes WorkflowEngine (phase
 * executor) + AutonomousPlanner (online decisions) + ResearchEventBus (events)
 * + LiveSteeringSource (human override). This mirrors the GoalEngine thin-shell
 * pattern but adds the reflective loop GoalEngine lacks.
 */

import type { WorkflowEngine } from '../workflow/WorkflowEngine.js';
import type { WorkflowDefinition, WorkflowHooks, WorkflowRun } from '../workflow/types.js';
import { LiveSteeringEventSchema, type LiveSteeringSource } from '../runtime/LiveSteeringContract.js';
import type { ResearchPhaseKind } from '../runtime/AutonomousRuntimeContract.js';
import {
  STRATEGY_ACTIONS,
  type ResearchStrategy,
  type PaperStructureTemplate,
  type StrategyActionKind,
} from '../runtime/ResearchStrategyContract.js';
import type { PersistenceStore } from '../persistence/PersistenceStore.js';
import { ResearchEventBus } from './ResearchEventBus.js';
import {
  AutonomousPlanner,
  type PlannedPhase,
  type PhaseHistoryEntry,
  type Reflection,
  type ResearchPlan,
} from './AutonomousPlanner.js';
import { PHASE_WORKFLOWS, buildPhaseInput } from './researchPhases.js';
import { ACTION_TEMPLATES, type ActionTemplate } from './researchActions.js';
import { ResearchMethodSpecSchema, type ResearchMethodSpec } from './researchMethods.js';

// ─── Types ────────────────────────────────────────────────────

export interface ResearchOutcome {
  sessionId: string;
  goal: string;
  status: 'completed' | 'interrupted' | 'failed' | 'paused';
  summary: string;
  phaseOutputs: Partial<Record<ResearchPhaseKind, string>>;
  iterations: number;
  artifactIds: string[];
  methodSpec?: ResearchMethodSpec;
  failureReason?: string;
}

export interface AutonomousPhaseArtifactInput {
  sessionId: string;
  projectId: string;
  goal: string;
  phase: ResearchPhaseKind;
  phaseName: string;
  iteration: number;
  output: string;
  methodSpec?: ResearchMethodSpec;
}

/** Authoritative persistence boundary for autonomous research deliverables. */
export interface AutonomousResearchArtifactSink {
  persistPhaseOutput(input: AutonomousPhaseArtifactInput): string | Promise<string>;
  listArtifactIds(sessionId: string, projectId: string): string[] | Promise<string[]>;
  finalizeRun?(
    sessionId: string,
    projectId: string,
    summary: string,
    artifactIds: string[],
  ): void | Promise<void>;
}

export interface AutonomousResearchEngineOptions {
  workflowEngine: WorkflowEngine;
  planner: AutonomousPlanner;
  eventBus: ResearchEventBus;
  liveSteering?: LiveSteeringSource;
  store?: PersistenceStore;
  artifactSink?: AutonomousResearchArtifactSink;
  /** Hard cap on total phase executions (incl. redos) to bound cost. */
  maxPhaseExecutions?: number;
  /** Automatic retry budget for a phase that throws before producing output. */
  maxFailuresPerPhase?: number;
}

const DEFAULT_MAX_PHASE_EXECUTIONS = 16;
const CHECKPOINT_PREFIX = 'autonomous:session:';
/** Checkpoint layout version; v2 persists the full plan so resume continues. */
const CHECKPOINT_VERSION = 2;

type SessionState = 'running' | 'paused' | 'interrupted';

interface ActiveSession {
  state: SessionState;
  pendingInstructions: string[];
  lastSteeringSequence: number;
}

export interface AutonomousCheckpoint {
  version: number;
  goal: string;
  phases: PlannedPhase[];
  revisionNotes: Partial<Record<ResearchPhaseKind, string>>;
  history: PhaseHistoryEntry[];
  phaseOutputs: Partial<Record<ResearchPhaseKind, string>>;
  executions: number;
  projectId?: string;
  state: 'running' | 'paused';
  /** True when the run was driven by a user-defined research strategy. */
  strategyMode?: boolean;
  /** Paper structure template used by the writing action (strategy mode). */
  structure?: PaperStructureTemplate;
  /** Per-phase user instructions (aligned with phases) in strategy mode. */
  phasePrompts?: Array<string | undefined>;
  methodSpec?: ResearchMethodSpec;
  failureCounts?: Record<string, number>;
  failureReason?: string;
  savedAt: number;
}

// ─── Engine ───────────────────────────────────────────────────

export class AutonomousResearchEngine {
  private readonly workflowEngine: WorkflowEngine;
  private readonly planner: AutonomousPlanner;
  private readonly eventBus: ResearchEventBus;
  private readonly liveSteering?: LiveSteeringSource;
  private readonly store?: PersistenceStore;
  private readonly artifactSink?: AutonomousResearchArtifactSink;
  private readonly maxPhaseExecutions: number;
  private readonly maxFailuresPerPhase: number;

  /** Active sessions keyed by sessionId, for control (pause/interrupt). */
  private readonly activeSessions = new Map<string, ActiveSession>();

  constructor(options: AutonomousResearchEngineOptions) {
    this.workflowEngine = options.workflowEngine;
    this.planner = options.planner;
    this.eventBus = options.eventBus;
    this.liveSteering = options.liveSteering;
    this.store = options.store;
    this.artifactSink = options.artifactSink;
    this.maxPhaseExecutions = options.maxPhaseExecutions ?? DEFAULT_MAX_PHASE_EXECUTIONS;
    this.maxFailuresPerPhase = options.maxFailuresPerPhase ?? 2;
  }

  /** Run a full autonomous research loop. Resolves when done or interrupted/paused. */
  async run(userGoal: string, sessionId: string, projectId?: string): Promise<ResearchOutcome> {
    this.planner.startRun();
    const session: ActiveSession = { state: 'running', pendingInstructions: [], lastSteeringSequence: 0 };
    this.activeSessions.set(sessionId, session);
    const plan = await this.planner.proposeResearchPlan(userGoal);
    const history: PhaseHistoryEntry[] = [];
    const phaseOutputs: Partial<Record<ResearchPhaseKind, string>> = {};

    this.eventBus.emit({
      type: 'engine-started',
      sessionId,
      goal: userGoal,
      plan: plan.phases.map((p) => ({ phase: p.phase, name: p.name })),
      method: plan.methodSpec ? methodSummary(plan.methodSpec) : undefined,
    });

    return this.runStrategyLoop(
      userGoal,
      sessionId,
      session,
      plan.phases,
      plan.methodSpec?.phases.map((item) => item.prompt) ?? [],
      history,
      phaseOutputs,
      0,
      { projectId, methodSpec: plan.methodSpec },
    );
  }

  /**
   * Run a user-defined research strategy: execute its phases (research
   * actions) in order, feeding each phase's output into the next. The phase
   * sequence is fully user-defined — no hard-coded paradigm.
   */
  async runWithStrategy(
    userGoal: string,
    sessionId: string,
    strategy: ResearchStrategy,
    options: { projectId?: string; structure?: PaperStructureTemplate } = {},
  ): Promise<ResearchOutcome> {
    this.planner.startRun();
    const session: ActiveSession = { state: 'running', pendingInstructions: [], lastSteeringSequence: 0 };
    this.activeSessions.set(sessionId, session);
    const phases: PlannedPhase[] = strategy.phases.map((p, index) => ({
      phase: p.action,
      name: p.name,
      iteration: index + 1,
    }));
    const phasePrompts: Array<string | undefined> = strategy.phases.map((p) => p.prompt);
    const history: PhaseHistoryEntry[] = [];
    const phaseOutputs: Partial<Record<ResearchPhaseKind, string>> = {};

    this.eventBus.emit({
      type: 'engine-started',
      sessionId,
      goal: userGoal,
      plan: phases.map((p) => ({ phase: p.phase, name: p.name })),
    });

    return this.runStrategyLoop(
      userGoal,
      sessionId,
      session,
      phases,
      phasePrompts,
      history,
      phaseOutputs,
      0,
      options,
    );
  }

  /** Execute (or continue) a strategy's phases from the given state. */
  private async runStrategyLoop(
    userGoal: string,
    sessionId: string,
    session: ActiveSession,
    phases: PlannedPhase[],
    phasePrompts: Array<string | undefined>,
    history: PhaseHistoryEntry[],
    phaseOutputs: Partial<Record<ResearchPhaseKind, string>>,
    executions: number,
    options: { projectId?: string; structure?: PaperStructureTemplate; methodSpec?: ResearchMethodSpec },
  ): Promise<ResearchOutcome> {
    let lastReflection: Reflection | null = null;
    let pausedReason = 'user_pause';
    let failureReason: string | undefined;
    const failureCounts: Record<string, number> = {};
    const budgetStart = executions;
    try {
      while (
        history.length < phases.length
        && executions - budgetStart < this.maxPhaseExecutions
      ) {
        const boundary = await this.checkInterrupt(sessionId, session);
        if (boundary === 'paused') { pausedReason = 'user_pause'; break; }
        if (boundary === 'interrupted') break;

        const phaseIndex = history.length;
        const planned = phases[phaseIndex];
        if (!planned) break;

        const template = ACTION_TEMPLATES[planned.phase as StrategyActionKind];
        if (!template) {
          failureReason = `研究阶段“${planned.phase}”没有可执行动作模板。`;
          break;
        }
        const priorOutputs = collectPriorOutputs(history);
        this.eventBus.emit({
          type: 'phase-started',
          sessionId,
          phase: planned.phase,
          phaseIteration: planned.iteration,
          phaseName: planned.name,
        });

        const steeringPrompt = consumeSteeringInstructions(session);
        const userPrompt = mergeInstructions(phasePrompts[phaseIndex], steeringPrompt);
        const workflow = buildStrategyActionWorkflow(
          planned,
          template,
          userGoal,
          priorOutputs,
          userPrompt,
          options.structure,
          options.methodSpec,
        );
        const hooks = this.buildPhaseHooks(sessionId, planned);
        executions += 1;
        let run: WorkflowRun;
        try {
          run = await this.workflowEngine.run(
            workflow,
            {},
            hooks,
            this.liveSteering,
            options.projectId ? { projectId: options.projectId } : undefined,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          const failureKey = `${phaseIndex}:${planned.phase}`;
          const failures = (failureCounts[failureKey] ?? 0) + 1;
          failureCounts[failureKey] = failures;
          const revisionNote = failures <= this.maxFailuresPerPhase
            ? `第 ${failures} 次执行异常（${message}）。缩小任务范围、检查可用资料与工具后自主重试。`
            : `阶段连续 ${failures} 次执行异常：${message}`;
          this.eventBus.emit({
            type: 'reflection',
            sessionId,
            phase: planned.phase,
            decision: 'redo',
            qualityScore: 0,
            reasoning: `阶段执行异常：${message}`,
            revisionNote,
          });
          phasePrompts[phaseIndex] = mergeInstructions(phasePrompts[phaseIndex], revisionNote);
          this.persistCheckpoint(sessionId, {
            goal: userGoal,
            phases,
            revisionNotes: {},
            history,
            phaseOutputs,
            executions,
            projectId: options.projectId,
            state: 'running',
            strategyMode: true,
            structure: options.structure,
            phasePrompts,
            methodSpec: options.methodSpec,
            failureCounts,
          });
          if (failures > this.maxFailuresPerPhase) {
            failureReason = `阶段“${planned.name}”在自主重试 ${this.maxFailuresPerPhase} 次后仍失败：${message}`;
            break;
          }
          continue;
        }

        const output = extractOutput(run, workflow);
        try {
          await this.persistPhaseArtifact({
            sessionId,
            projectId: options.projectId,
            goal: userGoal,
            phase: planned.phase,
            phaseName: planned.name,
            iteration: planned.iteration,
            output,
            methodSpec: options.methodSpec,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failureReason = `阶段“${planned.name}”已生成结果，但连续保存失败，未将本次运行标记为完成：${message}`;
          break;
        }
        history.push({ phase: planned.phase, iteration: planned.iteration, output });
        phaseOutputs[planned.phase] = output;
        this.eventBus.emit({
          type: 'progress',
          sessionId,
          completedPhases: history.length,
          totalPhases: phases.length,
          currentPhase: planned.phase,
        });

        const plannedNext = phases[history.length]?.phase;
        let reflection = await this.planner.reflect(planned.phase, output, history, userGoal, {
          nextPhase: plannedNext,
          isFinal: history.length >= phases.length,
          allowedPhases: [...STRATEGY_ACTIONS],
          qualityCriteria: options.methodSpec?.qualityCriteria,
        });
        // A provider cannot silently skip the remainder of the selected method.
        // Early "done" is treated as advance; the final phase may still finish.
        if (reflection.decision === 'done' && history.length < phases.length) {
          reflection = {
            ...reflection,
            decision: 'advance',
            nextPhase: plannedNext,
            reasoning: `${reflection.reasoning}\n方法计划仍有未完成阶段，继续自主执行。`,
          };
        }
        lastReflection = reflection;
        this.eventBus.emit({
          type: 'reflection',
          sessionId,
          phase: planned.phase,
          decision: reflection.decision,
          nextPhase: reflection.nextPhase,
          qualityScore: reflection.qualityScore,
          reasoning: reflection.reasoning,
          revisionNote: reflection.revisionNote,
        });

        if (reflection.decision === 'redo') {
          const retryIteration = phases.filter((item) => item.phase === planned.phase).length + 1;
          phases.splice(history.length, 0, {
            phase: planned.phase,
            name: `${planned.name}（自主重做 #${retryIteration}）`,
            iteration: retryIteration,
          });
          phasePrompts.splice(history.length, 0, mergeInstructions(
            phasePrompts[phaseIndex],
            reflection.revisionNote ?? '根据质量反思重新执行，并重点补足薄弱证据。',
          ));
        } else if (reflection.decision === 'rollback' && reflection.nextPhase) {
          rollbackStrategyExecution(
            phases,
            phasePrompts,
            history,
            phaseOutputs,
            reflection.nextPhase,
            reflection.revisionNote,
          );
        } else if (
          reflection.decision === 'advance'
          && reflection.nextPhase
          && reflection.nextPhase !== plannedNext
          && ACTION_TEMPLATES[reflection.nextPhase as StrategyActionKind]
        ) {
          // A reflection may discover a missing analysis/source-checking step.
          // Insert it as an exploratory branch, then return to the remaining
          // trusted method plan instead of asking the researcher to approve it.
          const branchIteration = phases.filter((item) => item.phase === reflection.nextPhase).length + 1;
          phases.splice(history.length, 0, {
            phase: reflection.nextPhase,
            name: `${ACTION_TEMPLATES[reflection.nextPhase as StrategyActionKind].label}（自主分支）`,
            iteration: branchIteration,
          });
          phasePrompts.splice(history.length, 0, mergeInstructions(
            reflection.revisionNote,
            `上一阶段反思认为需要补充此分支：${reflection.reasoning}`,
          ));
        }

        this.persistCheckpoint(sessionId, {
          goal: userGoal,
          phases,
          revisionNotes: {},
          history,
          phaseOutputs,
          executions,
          projectId: options.projectId,
          state: 'running',
          strategyMode: true,
          structure: options.structure,
          phasePrompts,
          methodSpec: options.methodSpec,
          failureCounts,
        });

        if (reflection.decision === 'done') break;
      }

      if (session.state === 'paused') {
        this.persistCheckpoint(sessionId, {
          goal: userGoal,
          phases,
          revisionNotes: {},
          history,
          phaseOutputs,
          executions,
          projectId: options.projectId,
          state: 'paused',
          strategyMode: true,
          structure: options.structure,
          phasePrompts,
          methodSpec: options.methodSpec,
          failureCounts,
        });
        this.eventBus.emit({ type: 'engine-paused', sessionId, reason: pausedReason });
        return {
          sessionId,
          goal: userGoal,
          status: 'paused',
          summary: composeSummary(userGoal, phaseOutputs, lastReflection),
          phaseOutputs,
          iterations: executions,
          artifactIds: await this.resolveArtifactIds(sessionId, options.projectId, phaseOutputs, false),
          methodSpec: options.methodSpec,
        };
      }

      if (session.state === 'interrupted') {
        return {
          sessionId,
          goal: userGoal,
          status: 'interrupted',
          summary: composeSummary(userGoal, phaseOutputs, lastReflection),
          phaseOutputs,
          iterations: executions,
          artifactIds: await this.resolveArtifactIds(sessionId, options.projectId, phaseOutputs, false),
          methodSpec: options.methodSpec,
        };
      }

      if (!failureReason && history.length < phases.length) {
        failureReason = `达到自主执行上限 ${this.maxPhaseExecutions}，仍有 ${phases.length - history.length} 个研究阶段未完成。`;
      }
      if (failureReason) {
        this.persistCheckpoint(sessionId, {
          goal: userGoal,
          phases,
          revisionNotes: {},
          history,
          phaseOutputs,
          executions,
          projectId: options.projectId,
          state: 'paused',
          strategyMode: true,
          structure: options.structure,
          phasePrompts,
          methodSpec: options.methodSpec,
          failureCounts,
          failureReason,
        });
        this.eventBus.emit({
          type: 'engine-failed',
          sessionId,
          reason: failureReason,
          completedPhases: history.length,
          recoverable: true,
        });
        return {
          sessionId,
          goal: userGoal,
          status: 'failed',
          summary: composeSummary(userGoal, phaseOutputs, lastReflection),
          phaseOutputs,
          iterations: executions,
          artifactIds: await this.resolveArtifactIds(sessionId, options.projectId, phaseOutputs, false),
          methodSpec: options.methodSpec,
          failureReason,
        };
      }

      const status: ResearchOutcome['status'] = 'completed';
      const summary = composeSummary(userGoal, phaseOutputs, lastReflection);
      let artifactIds: string[];
      try {
        artifactIds = await this.resolveArtifactIds(sessionId, options.projectId, phaseOutputs, true);
        if (this.artifactSink?.finalizeRun && options.projectId) {
          await this.artifactSink.finalizeRun(sessionId, options.projectId, summary, artifactIds);
        }
      } catch (error) {
        const reason = `研究阶段均已执行，但无法核验持久化产物，未将本次运行标记为完成：${error instanceof Error ? error.message : String(error)}`;
        this.persistCheckpoint(sessionId, {
          goal: userGoal,
          phases,
          revisionNotes: {},
          history,
          phaseOutputs,
          executions,
          projectId: options.projectId,
          state: 'paused',
          strategyMode: true,
          structure: options.structure,
          phasePrompts,
          methodSpec: options.methodSpec,
          failureCounts,
          failureReason: reason,
        });
        this.eventBus.emit({
          type: 'engine-failed',
          sessionId,
          reason,
          completedPhases: history.length,
          recoverable: true,
        });
        return {
          sessionId,
          goal: userGoal,
          status: 'failed',
          summary,
          phaseOutputs,
          iterations: executions,
          artifactIds: await this.resolveArtifactIds(sessionId, options.projectId, phaseOutputs, false),
          methodSpec: options.methodSpec,
          failureReason: reason,
        };
      }
      this.clearCheckpoint(sessionId);
      this.eventBus.emit({ type: 'engine-completed' as const, sessionId, summary, artifactIds });
      return {
        sessionId,
        goal: userGoal,
        status,
        summary,
        phaseOutputs,
        iterations: executions,
        artifactIds,
        methodSpec: options.methodSpec,
      };
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  /**
   * Resume a paused session from its persisted checkpoint. Completed phases
   * are NOT re-executed: the checkpointed plan + history drive pickNextPhase,
   * so the loop continues exactly where it stopped.
   */
  async resume(sessionId: string): Promise<ResearchOutcome> {
    const checkpoint = this.loadCheckpoint(sessionId);
    if (!checkpoint) throw new Error(`No checkpoint for session '${sessionId}'`);
    const session: ActiveSession = { state: 'running', pendingInstructions: [], lastSteeringSequence: 0 };
    this.activeSessions.set(sessionId, session);
    if (checkpoint.strategyMode) {
      // Strategy runs resume through the strategy executor with the
      // checkpointed phases (already-completed phases are skipped).
      this.eventBus.emit({
        type: 'engine-resumed',
        sessionId,
        completedPhases: checkpoint.history.length,
      });
      return this.runStrategyLoop(
        checkpoint.goal,
        sessionId,
        session,
        checkpoint.phases,
        checkpoint.phasePrompts ?? [],
        checkpoint.history,
        checkpoint.phaseOutputs,
        checkpoint.executions,
        {
          projectId: checkpoint.projectId,
          structure: checkpoint.structure,
          methodSpec: checkpoint.methodSpec,
        },
      );
    }
    const plan: ResearchPlan = {
      goal: checkpoint.goal,
      phases: checkpoint.phases,
      revisionNotes: checkpoint.revisionNotes,
    };
    this.eventBus.emit({
      type: 'engine-resumed',
      sessionId,
      completedPhases: checkpoint.history.length,
    });
    return this.runLoop(
      checkpoint.goal,
      sessionId,
      session,
      plan,
      checkpoint.history,
      checkpoint.phaseOutputs,
      checkpoint.executions,
      checkpoint.projectId,
    );
  }

  /**
   * Request a cooperative pause; takes effect at the next phase boundary.
   * The engine-paused event is emitted by the loop itself when it actually
   * stops, so renderers get exactly one authoritative transition.
   */
  pause(sessionId: string): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session || session.state !== 'running') return false;
    session.state = 'paused';
    return true;
  }

  /** Request an interrupt for a running session (cooperative, between phases). */
  interrupt(sessionId: string, reason = 'user_requested'): boolean {
    const session = this.activeSessions.get(sessionId);
    if (!session) return false;
    session.state = 'interrupted';
    this.eventBus.emit({ type: 'engine-interrupted', sessionId, reason });
    return true;
  }

  /** Whether a session is currently running (not paused). */
  isActive(sessionId: string): boolean {
    return this.activeSessions.has(sessionId);
  }

  // ─── Internals ──────────────────────────────────────────────

  private async runLoop(
    userGoal: string,
    sessionId: string,
    session: ActiveSession,
    plan: ResearchPlan,
    history: PhaseHistoryEntry[],
    phaseOutputs: Partial<Record<ResearchPhaseKind, string>>,
    executions: number,
    projectId?: string,
  ): Promise<ResearchOutcome> {
    let lastReflection: Reflection | null = null;
    let pausedReason = 'user_pause';
    let failureReason: string | undefined;
    const budgetStart = executions;
    try {
      while (executions - budgetStart < this.maxPhaseExecutions) {
        // 1. Check for human pause/interrupt before picking the next phase.
        const boundary = await this.checkInterrupt(sessionId, session);
        if (boundary === 'paused') {
          pausedReason = session.state === 'paused' ? 'user_pause' : pausedReason;
          break;
        }
        if (boundary === 'interrupted') break;

        // 2. Pick the next phase (plan may have been revised by reflection).
        const planned = this.planner.pickNextPhase(plan, history);
        if (!planned) {
          // Plan exhausted and last reflection didn't say done — finish anyway.
          break;
        }

        // 3. Execute the phase via WorkflowEngine.
        executions += 1;
        const workflow = PHASE_WORKFLOWS[planned.phase]!;
        const priorOutputs = collectPriorOutputs(history);
        const revisionNote = plan.revisionNotes[planned.phase];
        const input = buildPhaseInput(userGoal, priorOutputs, revisionNote);

        this.eventBus.emit({
          type: 'phase-started',
          sessionId,
          phase: planned.phase,
          phaseIteration: planned.iteration,
          phaseName: planned.name,
        });

        const hooks = this.buildPhaseHooks(sessionId, planned);
        let run: WorkflowRun;
        try {
          run = await this.workflowEngine.run(
            workflow,
            input,
            hooks,
            this.liveSteering,
            projectId ? { projectId } : undefined,
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          this.eventBus.emit({
            type: 'reflection',
            sessionId,
            phase: planned.phase,
            decision: 'redo',
            qualityScore: 0,
            reasoning: `阶段执行异常：${message}`,
            revisionNote: '上次执行抛出异常，请简化方案重试。',
          });
          // No history entry was added, so the cursor already points at this
          // phase. Updating its revision note retries it immediately; appending
          // another plan item would defer the retry until after later phases.
          plan.revisionNotes[planned.phase] = `异常：${message}`;
          this.persistCheckpoint(sessionId, {
            goal: userGoal,
            phases: plan.phases,
            revisionNotes: plan.revisionNotes,
            history,
            phaseOutputs,
            executions,
            projectId,
            state: 'running',
          });
          continue;
        }

        const output = extractOutput(run, workflow);
        try {
          await this.persistPhaseArtifact({
            sessionId,
            projectId,
            goal: userGoal,
            phase: planned.phase,
            phaseName: planned.name,
            iteration: planned.iteration,
            output,
          });
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          failureReason = `阶段“${planned.name}”已生成结果，但连续保存失败，未将本次运行标记为完成：${message}`;
          break;
        }
        history.push({ phase: planned.phase, iteration: planned.iteration, output });
        phaseOutputs[planned.phase] = output;
        this.eventBus.emit({
          type: 'progress',
          sessionId,
          completedPhases: history.length,
          totalPhases: plan.phases.length,
          currentPhase: planned.phase,
        });
        this.persistCheckpoint(sessionId, {
          goal: userGoal,
          phases: plan.phases,
          revisionNotes: plan.revisionNotes,
          history,
          phaseOutputs,
          executions,
          projectId,
          state: 'running',
        });

        // 4. Reflect on the phase output.
        const reflection = await this.planner.reflect(planned.phase, output, history, userGoal, {
          nextPhase: plan.phases[history.length]?.phase,
          isFinal: history.length >= plan.phases.length,
          allowedPhases: [...new Set(plan.phases.map((item) => item.phase))],
        });
        lastReflection = reflection;
        this.eventBus.emit({
          type: 'reflection',
          sessionId,
          phase: planned.phase,
          decision: reflection.decision,
          nextPhase: reflection.nextPhase,
          qualityScore: reflection.qualityScore,
          reasoning: reflection.reasoning,
          revisionNote: reflection.revisionNote,
        });

        if (reflection.decision === 'done') break;
        if (reflection.decision === 'redo') {
          this.planner.reviseForRedo(
            plan,
            planned.phase,
            reflection.revisionNote ?? '根据质量反思重新执行并补足薄弱证据。',
            history.length,
          );
          continue;
        }
        if (reflection.decision === 'rollback' && reflection.nextPhase) {
          if (reflection.revisionNote) {
            this.planner.reviseForRollback(plan, history, reflection.nextPhase, reflection.revisionNote);
          }
          continue;
        }
        // advance: the plan's next entry is picked on the next iteration.
      }

      if (session.state === 'paused') {
        // Paused: the checkpoint above already recorded the latest progress;
        // persist once more with the paused marker so resume knows where to
        // continue. No engine-completed event — the run is only suspended.
        this.persistCheckpoint(sessionId, {
          goal: userGoal,
          phases: plan.phases,
          revisionNotes: plan.revisionNotes,
          history,
          phaseOutputs,
          executions,
          projectId,
          state: 'paused',
        });
        this.eventBus.emit({ type: 'engine-paused', sessionId, reason: pausedReason });
        return {
          sessionId,
          goal: userGoal,
          status: 'paused',
          summary: composeSummary(userGoal, phaseOutputs, lastReflection),
          phaseOutputs,
          iterations: executions,
          artifactIds: await this.resolveArtifactIds(sessionId, projectId, phaseOutputs, false),
        };
      }

      if (session.state === 'interrupted') {
        return {
          sessionId,
          goal: userGoal,
          status: 'interrupted',
          summary: composeSummary(userGoal, phaseOutputs, lastReflection),
          phaseOutputs,
          iterations: executions,
          artifactIds: await this.resolveArtifactIds(sessionId, projectId, phaseOutputs, false),
        };
      }

      if (failureReason || history.length < plan.phases.length) {
        const reason = failureReason
          ?? `达到自主执行上限 ${this.maxPhaseExecutions}，仍有 ${plan.phases.length - history.length} 个阶段未完成。`;
        this.eventBus.emit({
          type: 'engine-failed',
          sessionId,
          reason,
          completedPhases: history.length,
          recoverable: true,
        });
        return {
          sessionId,
          goal: userGoal,
          status: 'failed',
          summary: composeSummary(userGoal, phaseOutputs, lastReflection),
          phaseOutputs,
          iterations: executions,
          artifactIds: await this.resolveArtifactIds(sessionId, projectId, phaseOutputs, false),
          failureReason: reason,
        };
      }

      const status: ResearchOutcome['status'] = 'completed';
      const summary = composeSummary(userGoal, phaseOutputs, lastReflection);
      let artifactIds: string[];
      try {
        artifactIds = await this.resolveArtifactIds(sessionId, projectId, phaseOutputs, true);
        if (this.artifactSink?.finalizeRun && projectId) {
          await this.artifactSink.finalizeRun(sessionId, projectId, summary, artifactIds);
        }
      } catch (error) {
        const reason = `研究阶段均已执行，但无法核验持久化产物，未将本次运行标记为完成：${error instanceof Error ? error.message : String(error)}`;
        this.eventBus.emit({
          type: 'engine-failed',
          sessionId,
          reason,
          completedPhases: history.length,
          recoverable: true,
        });
        return {
          sessionId,
          goal: userGoal,
          status: 'failed',
          summary,
          phaseOutputs,
          iterations: executions,
          artifactIds: await this.resolveArtifactIds(sessionId, projectId, phaseOutputs, false),
          failureReason: reason,
        };
      }

      this.clearCheckpoint(sessionId);
      this.eventBus.emit({
        type: 'engine-completed' as const,
        sessionId,
        summary,
        artifactIds,
      });

      return { sessionId, goal: userGoal, status, summary, phaseOutputs, iterations: executions, artifactIds };
    } finally {
      this.activeSessions.delete(sessionId);
    }
  }

  // ─── Internals ──────────────────────────────────────────────

  private async persistPhaseArtifact(
    input: Omit<AutonomousPhaseArtifactInput, 'projectId'> & { projectId?: string },
  ): Promise<void> {
    if (!this.artifactSink || !input.projectId) return;
    let lastError: unknown;
    for (let attempt = 0; attempt < 3; attempt += 1) {
      try {
        await this.artifactSink.persistPhaseOutput({ ...input, projectId: input.projectId });
        return;
      } catch (error) {
        lastError = error;
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError ?? 'unknown persistence error'));
  }

  private async resolveArtifactIds(
    sessionId: string,
    projectId: string | undefined,
    phaseOutputs: Partial<Record<ResearchPhaseKind, string>>,
    strict: boolean,
  ): Promise<string[]> {
    const embeddedIds = extractArtifactIds(phaseOutputs);
    if (!this.artifactSink || !projectId) return embeddedIds;
    try {
      const storedIds = await this.artifactSink.listArtifactIds(sessionId, projectId);
      return [...new Set([...storedIds, ...embeddedIds])];
    } catch (error) {
      if (strict) throw error;
      return embeddedIds;
    }
  }

  private async checkInterrupt(sessionId: string, session: ActiveSession): Promise<'paused' | 'interrupted' | 'none'> {
    if (session.state === 'paused') return 'paused';
    if (session.state === 'interrupted') return 'interrupted';
    if (!this.liveSteering) return 'none';
    try {
      const events = await this.liveSteering.drain({
        sessionId,
        afterSequence: session.lastSteeringSequence,
      });
      for (const raw of events) {
        const parsed = LiveSteeringEventSchema.safeParse(raw);
        if (!parsed.success || parsed.data.sessionId !== sessionId) continue;
        session.lastSteeringSequence = Math.max(session.lastSteeringSequence, parsed.data.sequence);
        if (parsed.data.type === 'instruction') {
          // Ordinary steering refines the next phase; it must not abort an
          // autonomous run merely because the researcher added context.
          session.pendingInstructions.push(parsed.data.content);
          continue;
        }
        session.state = 'interrupted';
        this.eventBus.emit({
          type: 'engine-interrupted',
          sessionId,
          reason: parsed.data.reason,
        });
        return 'interrupted';
      }
    } catch { /* ignore drain errors */ }
    return 'none';
  }

  private buildPhaseHooks(
    sessionId: string,
    planned: PlannedPhase,
  ): WorkflowHooks {
    return {
      onStepStart: (step) => {
        this.eventBus.emit({
          type: 'step-start',
          sessionId,
          phase: planned.phase,
          stepId: step.id,
          stepName: step.name,
        });
      },
      onStepComplete: (step, result) => {
        this.eventBus.emit({
          type: 'step-complete',
          sessionId,
          phase: planned.phase,
          stepId: step.id,
          stepName: step.name,
          output: result.output.slice(0, 100_000),
        });
      },
      onStepFailed: (step, result) => {
        this.eventBus.emit({
          type: 'step-failed',
          sessionId,
          phase: planned.phase,
          stepId: step.id,
          stepName: step.name,
          error: (result.output || 'step failed').slice(0, 20_000),
        });
      },
    };
  }

  private persistCheckpoint(
    sessionId: string,
    data: {
      goal: string;
      phases: PlannedPhase[];
      revisionNotes: Partial<Record<ResearchPhaseKind, string>>;
      history: PhaseHistoryEntry[];
      phaseOutputs: Partial<Record<ResearchPhaseKind, string>>;
      executions: number;
      projectId?: string;
      state: 'running' | 'paused';
      strategyMode?: boolean;
      structure?: PaperStructureTemplate;
      phasePrompts?: Array<string | undefined>;
      methodSpec?: ResearchMethodSpec;
      failureCounts?: Record<string, number>;
      failureReason?: string;
    },
  ): void {
    if (!this.store) return;
    try {
      this.store.setMemory(
        `${CHECKPOINT_PREFIX}${sessionId}`,
        JSON.stringify({ version: CHECKPOINT_VERSION, ...data, savedAt: Date.now() }),
        'autonomous_checkpoint',
      );
    } catch { /* checkpoint failures must never break the loop */ }
  }

  private clearCheckpoint(sessionId: string): void {
    if (!this.store) return;
    try {
      this.store.deleteMemory(`${CHECKPOINT_PREFIX}${sessionId}`);
    } catch { /* durable project/run records remain authoritative */ }
  }

  /** Load a saved checkpoint for resume/crash recovery. */
  loadCheckpoint(sessionId: string): AutonomousCheckpoint | null {
    if (!this.store) return null;
    try {
      const entry = this.store.getMemory(`${CHECKPOINT_PREFIX}${sessionId}`);
      if (!entry?.value) return null;
      const raw = JSON.parse(entry.value) as Partial<AutonomousCheckpoint>;
      // v1 checkpoints (pre plan persistence) rebuild a fresh plan; the goal
      // and history still allow a best-effort continuation.
      if (raw.version !== CHECKPOINT_VERSION) {
        const plan = this.planner.proposeInitialGoal(String(raw.goal ?? ''));
        return {
          version: CHECKPOINT_VERSION,
          goal: String(raw.goal ?? ''),
          phases: plan.phases,
          revisionNotes: {},
          history: Array.isArray(raw.history) ? (raw.history as PhaseHistoryEntry[]) : [],
          phaseOutputs: (raw.phaseOutputs ?? {}) as Partial<Record<ResearchPhaseKind, string>>,
          executions: typeof raw.executions === 'number' ? raw.executions : 0,
          projectId: typeof raw.projectId === 'string' ? raw.projectId : undefined,
          state: 'paused',
          savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
        };
      }
      return {
        version: CHECKPOINT_VERSION,
        goal: String(raw.goal ?? ''),
        phases: Array.isArray(raw.phases) ? (raw.phases as PlannedPhase[]) : [],
        revisionNotes: (raw.revisionNotes ?? {}) as Partial<Record<ResearchPhaseKind, string>>,
        history: Array.isArray(raw.history) ? (raw.history as PhaseHistoryEntry[]) : [],
        phaseOutputs: (raw.phaseOutputs ?? {}) as Partial<Record<ResearchPhaseKind, string>>,
        executions: typeof raw.executions === 'number' ? raw.executions : 0,
        projectId: typeof raw.projectId === 'string' ? raw.projectId : undefined,
        state: raw.state === 'running' ? 'running' : 'paused',
        savedAt: typeof raw.savedAt === 'number' ? raw.savedAt : Date.now(),
        strategyMode: raw.strategyMode === true ? true : undefined,
        structure: raw.structure,
        phasePrompts: Array.isArray(raw.phasePrompts) ? raw.phasePrompts : undefined,
        methodSpec: ResearchMethodSpecSchema.safeParse(raw.methodSpec).success
          ? ResearchMethodSpecSchema.parse(raw.methodSpec)
          : undefined,
        failureCounts: raw.failureCounts && typeof raw.failureCounts === 'object'
          ? raw.failureCounts as Record<string, number>
          : undefined,
        failureReason: typeof raw.failureReason === 'string' ? raw.failureReason : undefined,
      };
    } catch { return null; }
  }
}

// ─── Helpers ──────────────────────────────────────────────────

function methodSummary(methodSpec: ResearchMethodSpec): NonNullable<import('./ResearchEventBus.js').EngineStartedEvent['method']> {
  return {
    family: methodSpec.family,
    name: methodSpec.name,
    rationale: methodSpec.rationale,
    confidence: methodSpec.confidence,
    selectedBy: methodSpec.selectedBy,
  };
}

function consumeSteeringInstructions(session: ActiveSession): string | undefined {
  if (session.pendingInstructions.length === 0) return undefined;
  const instructions = session.pendingInstructions.splice(0, session.pendingInstructions.length);
  return `研究者在运行中补充的方向（直接纳入后续执行，不需要暂停确认）：\n${instructions.join('\n\n')}`;
}

function mergeInstructions(...values: Array<string | undefined>): string | undefined {
  const merged = values.map((value) => value?.trim()).filter((value): value is string => Boolean(value));
  return merged.length > 0 ? merged.join('\n\n') : undefined;
}

function rebuildPhaseOutputs(
  history: PhaseHistoryEntry[],
  phaseOutputs: Partial<Record<ResearchPhaseKind, string>>,
): void {
  for (const key of Object.keys(phaseOutputs) as ResearchPhaseKind[]) delete phaseOutputs[key];
  for (const entry of history) phaseOutputs[entry.phase] = entry.output;
}

function rollbackStrategyExecution(
  phases: PlannedPhase[],
  phasePrompts: Array<string | undefined>,
  history: PhaseHistoryEntry[],
  phaseOutputs: Partial<Record<ResearchPhaseKind, string>>,
  targetPhase: ResearchPhaseKind,
  revisionNote?: string,
): boolean {
  const targetHistoryIndex = history.findIndex((entry) => entry.phase === targetPhase);
  if (targetHistoryIndex < 0) return false;
  const targetPlanIndex = phases.findIndex((item, index) => index >= targetHistoryIndex && item.phase === targetPhase);
  if (targetPlanIndex < 0) return false;

  const prefix = phases.slice(0, targetHistoryIndex);
  const tail = phases.slice(targetPlanIndex).map((item, index) => (
    index === 0
      ? { ...item, name: `${item.name}（自主回退重做）`, iteration: item.iteration + 1 }
      : { ...item }
  ));
  const promptPrefix = phasePrompts.slice(0, targetHistoryIndex);
  const promptTail = phasePrompts.slice(targetPlanIndex);
  if (promptTail.length === 0) promptTail.push(undefined);
  promptTail[0] = mergeInstructions(promptTail[0], revisionNote ?? '根据后续发现回退，修正此前的研究设计或证据判断。');

  history.splice(targetHistoryIndex);
  phases.splice(0, phases.length, ...prefix, ...tail);
  phasePrompts.splice(0, phasePrompts.length, ...promptPrefix, ...promptTail);
  rebuildPhaseOutputs(history, phaseOutputs);
  return true;
}

/** Tool set per research action (user-defined strategies). Reading PDFs and
 *  searching literature are the shared capabilities; analysis/argumentation
 *  additionally get project memory recall. */
function toolsForAction(kind: StrategyActionKind): string[] {
  switch (kind) {
    case 'question_formulation':
    case 'research_design':
      return ['search_library', 'list_sources', 'memory_recall', 'web_search'];
    case 'literature_review':
    case 'source_discovery':
    case 'screening':
      return ['arxiv_search', 'search_papers', 'crossref_lookup', 'web_search', 'web_fetch', 'read_pdf', 'search_library'];
    case 'data_collection':
      return ['web_search', 'web_fetch', 'read_pdf', 'search_library', 'list_sources', 'memory_recall'];
    case 'data_preparation':
    case 'statistics':
      return ['read_file', 'write_file', 'execute_code', 'search_library', 'memory_recall'];
    case 'conceptual_analysis':
    case 'source_criticism':
    case 'coding':
    case 'analysis':
      return ['read_pdf', 'search_library', 'list_sources', 'memory_recall'];
    case 'triangulation':
    case 'quality_audit':
      return ['read_pdf', 'search_library', 'list_sources', 'memory_recall', 'verify_claim', 'provenance_check'];
    case 'argumentation':
    case 'writing':
    case 'synthesis':
      return ['read_pdf', 'search_library', 'memory_recall'];
    default:
      return ['read_pdf', 'search_library'];
  }
}

/** Build a single-step workflow that runs one research action via the agent. */
function buildStrategyActionWorkflow(
  planned: PlannedPhase,
  template: ActionTemplate,
  goal: string,
  priorOutputs: Record<string, string>,
  userPrompt: string | undefined,
  structure?: PaperStructureTemplate,
  methodSpec?: ResearchMethodSpec,
): WorkflowDefinition {
  const methodInstruction = methodSpec
    ? [
      `自动选择的研究方法：${methodSpec.name}（${methodSpec.family}）`,
      `选择理由：${methodSpec.rationale}`,
      `本研究的质量标准：\n- ${methodSpec.qualityCriteria.join('\n- ')}`,
      '请自主推进；只有遇到必须由研究者提供的现实材料或不可逆外部行动时，才把限制写入结果，不要为普通方法选择暂停等待确认。',
    ].join('\n')
    : undefined;
  return {
    id: `action_${planned.phase}_${planned.iteration}`,
    name: planned.name,
    description: template.label,
    version: '1.0',
    steps: [
      {
        id: 'action_step',
        name: planned.name,
        description: template.label,
        prompt: template.buildUserPrompt({
          goal,
          priorOutputs,
          userPrompt: mergeInstructions(userPrompt, methodInstruction),
          structure,
        }),
        inputFrom: [],
        // Research actions are useless without reading ability: give each action
        // the tool set its workflow needs (the user-defined strategy engine
        // previously ran actions with no tools at all).
        tools: toolsForAction(template.kind),
        maxTurns: 6,
      },
    ],
    dependencies: {},
  };
}

function collectPriorOutputs(history: PhaseHistoryEntry[]): Record<string, string> {
  // Map each phase's latest output to its phase key, plus cross-phase references
  // that the phase prompts rely on (hypothesis/record/interpret/compare).
  const out: Record<string, string> = {};
  for (const entry of history) {
    out[entry.phase] = entry.output;
  }
  // Convenience aliases used by downstream phase prompts.
  if (out.idea) out.hypothesis = out.idea;
  if (out.experiment) out.record = out.experiment;
  if (out.analysis) {
    out.interpret = out.analysis;
    out.compare = out.analysis;
  }
  if (out.paper) {
    out.outline = out.paper;
    out.draft_sections = out.paper;
    out.compile_latex = out.paper;
  }
  return out;
}

function extractOutput(run: WorkflowRun, workflow: WorkflowDefinition): string {
  // Use the last step's output as the phase's representative output.
  const lastStepId = workflow.steps[workflow.steps.length - 1]?.id;
  if (lastStepId && run.stepResults[lastStepId]?.output) {
    return run.stepResults[lastStepId]!.output;
  }
  // Fallback: concatenate all step outputs.
  return workflow.steps
    .map((s) => run.stepResults[s.id]?.output ?? '')
    .filter(Boolean)
    .join('\n\n---\n\n');
}

function composeSummary(
  goal: string,
  phaseOutputs: Partial<Record<ResearchPhaseKind, string>>,
  reflection: Reflection | null,
): string {
  const parts: string[] = [`研究目标：${goal}`];
  if (phaseOutputs.writing) {
    parts.push(`研究成果：\n${phaseOutputs.writing.slice(0, 4000)}`);
  } else if (phaseOutputs.paper) {
    parts.push(`论文摘要：\n${phaseOutputs.paper.slice(0, 4000)}`);
  } else if (phaseOutputs.synthesis) {
    parts.push(`综合结论：\n${phaseOutputs.synthesis.slice(0, 4000)}`);
  } else if (phaseOutputs.analysis) {
    parts.push(`分析结论：\n${phaseOutputs.analysis.slice(0, 4000)}`);
  } else if (phaseOutputs.experiment) {
    parts.push(`实验结果：\n${phaseOutputs.experiment.slice(0, 4000)}`);
  } else if (phaseOutputs.idea) {
    parts.push(`选题与假设：\n${phaseOutputs.idea.slice(0, 4000)}`);
  }
  if (reflection) {
    parts.push(`最终反思：${reflection.reasoning.slice(0, 1000)}`);
  }
  return parts.join('\n\n');
}

function extractArtifactIds(phaseOutputs: Partial<Record<ResearchPhaseKind, string>>): string[] {
  // Scan paper output for artifact id markers; real artifact persistence is
  // handled by the tool layer (findings/artifacts). This is a best-effort pull.
  const ids: string[] = [];
  const text = phaseOutputs.writing ?? phaseOutputs.paper ?? '';
  const matches = text.match(/artifact[_-]?id[:\s]+([A-Za-z0-9_-]{4,64})/giu);
  if (matches) {
    for (const m of matches) {
      const id = m.split(/[:\s]+/u).pop();
      if (id) ids.push(id);
    }
  }
  return ids;
}
