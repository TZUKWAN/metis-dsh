/**
 * Workflow engine — serial DAG executor for single-agent workflows.
 *
 * Ported from metis/swarm/ concepts (DAG + topological sort + serial execution).
 *
 * Flow:
 *   1. Topological sort steps
 *   2. For each step in order:
 *      a. Check upstream dependencies completed
 *      b. Collect upstream outputs
 *      c. HITL approval (if required)
 *      d. Execute agent loop with step's prompt
 *      e. Store result
 *   3. Return WorkflowRun with all results
 */

import type { AgentRunRequest, AgentRunResult, ChatMessage, ToolEffectSnapshot } from '../core/types.js';
import type { AgentLoop } from '../core/AgentLoop.js';
import type {
  WorkflowDefinition,
  WorkflowStep,
  WorkflowRun,
  StepResult,
  WorkflowHooks,
  WorkflowCheckpoint,
  WorkflowRunOptions,
} from './types.js';
import { topologicalSort } from './types.js';
import { evaluateAcceptanceCriteria, hasAcceptanceCriteria } from './AcceptanceCriteria.js';

/**
 * O7: consecutive-failure threshold at which a step escalates to a human
 * decision (retry / skip / stop) instead of silently looping. Matches
 * mission-control's "after 3 attempts, escalates to a user decision" policy.
 */
export const STEP_FAILURE_ESCALATION_THRESHOLD = 3;

export class WorkflowEngine {
  private readonly agent: AgentLoop;

  constructor(agent: AgentLoop) {
    this.agent = agent;
  }

  /**
   * Execute a workflow definition serially.
   *
   * @param liveSteering Optional steering source forwarded to every step's
   *   AgentLoop.run, so human pause/interrupt can take effect mid-step (not
   *   only at phase boundaries). Used by the autonomous research engine.
   * @param options O13/O14 执行选项：provider 绑定、项目作用域、checkpoint 恢复。
   *   提供 options.checkpointRun 时，其中已 completed 的步骤结果被搬入新 run
   *   并跳过执行，实现「从上次失败点续跑」而非从 0 重来。
   */
  async run(
    definition: WorkflowDefinition,
    input: Record<string, unknown> = {},
    hooks?: WorkflowHooks,
    liveSteering?: import('../runtime/LiveSteeringContract.js').LiveSteeringSource,
    options?: WorkflowRunOptions,
  ): Promise<WorkflowRun> {
    const order = topologicalSort(definition);
    const stepMap = new Map(definition.steps.map((s) => [s.id, s]));

    const runId = `wf_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    const run: WorkflowRun = {
      id: runId,
      workflowId: definition.id,
      status: 'running',
      currentStepId: null,
      stepResults: {},
      startedAt: Date.now(),
      completedAt: null,
      input,
      errors: [],
      continuityId: options?.checkpointRun?.continuityId ?? options?.checkpointRun?.id ?? runId,
      ...(options?.goalId ? { goalId: options.goalId } : {}),
      ...(options?.projectId ? { projectId: options.projectId } : {}),
      ...(options?.planVersion !== undefined ? { planVersion: options.planVersion } : {}),
      ...(options?.runVersion !== undefined ? { runVersion: options.runVersion } : {}),
      ...(options?.checkpointRun?.projectRules
        ? { projectRules: options.checkpointRun.projectRules }
        : options?.projectRules
          ? { projectRules: options.projectRules }
          : {}),
      ...(options?.providerBinding ? { providerBinding: options.providerBinding } : {}),
    };

    // Initialize all step results as pending
    for (const step of definition.steps) {
      run.stepResults[step.id] = {
        stepId: step.id,
        status: 'pending',
        output: '',
        agentResult: null,
        startedAt: 0,
        completedAt: null,
        retryCount: 0,
      };
    }

    // O14: 从 checkpoint 搬入已完成步骤的结果（含输出与 agent 结果），
    // 使下游步骤可以继续引用 {{stepId.output}} 而不必重新执行上游。
    let completedCount = 0;
    if (options?.checkpointRun) {
      for (const stepId of order) {
        const checkpointResult = options.checkpointRun.stepResults[stepId];
        if (checkpointResult?.status === 'completed') {
          run.stepResults[stepId] = { ...checkpointResult, status: 'completed' };
          completedCount++;
        }
      }
    }
    const totalCount = definition.steps.length;

    for (const stepId of order) {
      const step = stepMap.get(stepId);
      if (!step) continue;

      // Goal-owned pause/cancel controls are checked at every step boundary.
      // A pause retains the current checkpoint for a truthful resume; a cancel
      // is terminal and never masquerades as a failed or completed workflow.
      if (applyRequestedControl(run, stepId, options)) {
        await this.publishCheckpoint(definition, run, hooks);
        return run;
      }

      // Get or create step result (guaranteed to exist from initialization)
      const stepResult = this.getOrCreateStepResult(run, stepId);

      // O14: checkpoint 中已完成的步骤直接跳过，不再执行、不重复触发 hook。
      if (stepResult.status === 'completed' && options?.checkpointRun) {
        continue;
      }

      // Check if all dependencies completed
      const deps = definition.dependencies[stepId];
      // Skipped steps (user chose "skip" on an escalated step) count as
      // satisfied so downstream steps can still run.
      const allDepsComplete = deps?.every((dep: string) =>
        run.stepResults[dep]?.status === 'completed'
        || (
          run.stepResults[dep]?.status === 'skipped'
          && run.stepResults[dep]?.skipReason === 'human_decision'
        )) ?? true;

      if (!allDepsComplete) {
        stepResult.status = 'skipped';
        stepResult.skipReason = 'dependency_unmet';
        continue;
      }

      // Collect upstream outputs
      const upstreamOutputs = collectUpstreamOutputs(step, run.stepResults);

      // HITL approval
      if (step.hitl?.requireApproval && hooks?.onApprovalRequired) {
        const approved = await hooks.onApprovalRequired(step, run);
        if (!approved) {
          run.status = 'paused';
          run.currentStepId = stepId;
          await this.publishCheckpoint(definition, run, hooks);
          return run;
        }
      }

      // Execute step
      run.currentStepId = stepId;
      stepResult.status = 'running';
      stepResult.startedAt = Date.now();

      if (hooks?.onStepStart) {
        await hooks.onStepStart(step, run);
      }
      await this.publishCheckpoint(definition, run, hooks);

      if (hooks?.onProgress) {
        hooks.onProgress(completedCount, totalCount, step);
      }

      const result = await this.executeStep(run, definition, hooks, step, upstreamOutputs, input, liveSteering, options);

      // Preserve any partial Agent history before applying a cancellation
      // boundary. A provider may have returned useful context even if the
      // Goal was cancelled before this Step could be marked completed.
      stepResult.agentResult = result.agentResult;
      stepResult.retryCount = result.retryCount;

      // Cancellation may abort the in-flight AgentLoop call. Check it before
      // interpreting its interrupted response as a normal step failure.
      if (applyRequestedControl(run, stepId, options, { pauseAtBoundaryOnly: true })) {
        await this.publishCheckpoint(definition, run, hooks);
        return run;
      }

      if (result.status === 'completed') {
        stepResult.status = 'completed';
        stepResult.output = result.output;
        stepResult.completedAt = Date.now();
        completedCount++;
        await this.publishCheckpoint(definition, run, hooks);

        if (hooks?.onStepComplete) {
          await hooks.onStepComplete(step, stepResult, run);
        }

        if (hooks?.onProgress) {
          hooks.onProgress(completedCount, totalCount, step);
        }
      } else {
        stepResult.status = 'failed';
        stepResult.completedAt = Date.now();
        // O7: escalate to a human decision after repeated consecutive failures.
        // Mirrors mission-control's loop detection: pause the run and require
        // retry / skip / stop instead of silently continuing or failing.
        const priorReasons = stepResult.failureReasons ?? [];
        const attemptReason = result.failureReasons ?? [`Step '${step.name}' (${stepId}) failed`];
        stepResult.failureReasons = [...priorReasons, ...attemptReason];
        if (result.retryCount + 1 >= STEP_FAILURE_ESCALATION_THRESHOLD) {
          stepResult.decisionRequired = true;
          run.status = 'paused';
          run.currentStepId = stepId;
          run.errors.push(`Step '${step.name}' (${stepId}) failed ${result.retryCount + 1} times — awaiting human decision (retry/skip/stop)`);
          if (hooks?.onStepFailed) {
            await hooks.onStepFailed(step, stepResult, run);
          }
          await this.publishCheckpoint(definition, run, hooks);
          return run;
        }
        run.errors.push(`Step '${step.name}' (${stepId}) failed`);

        if (hooks?.onStepFailed) {
          await hooks.onStepFailed(step, stepResult, run);
        }
        await this.publishCheckpoint(definition, run, hooks);

        // Continue to next step (don't abort entire workflow)
      }
    }

    run.status = run.errors.length === 0 ? 'completed' : 'failed';
    run.completedAt = Date.now();
    run.currentStepId = null;
    await this.publishCheckpoint(definition, run, hooks);
    return run;
  }

  /**
   * Resume a paused workflow from a specific step.
   *
   * O14: 从 fromStepId 起遍历拓扑序；凡是在 pausedRun 中已经 completed 的
   * 步骤直接跳过（保留其输出供下游引用），只重新执行未完成/失败的步骤，
   * 即「恢复到最近成功 checkpoint 后继续」。
   */
  async resume(
    definition: WorkflowDefinition,
    pausedRun: WorkflowRun,
    fromStepId: string,
    hooks?: WorkflowHooks,
    liveSteering?: import('../runtime/LiveSteeringContract.js').LiveSteeringSource,
    options?: WorkflowRunOptions,
  ): Promise<WorkflowRun> {
    const order = topologicalSort(definition);
    const fromIndex = order.indexOf(fromStepId);
    if (fromIndex === -1) {
      throw new Error(`Step '${fromStepId}' not found in workflow`);
    }

    const stepMap = new Map(definition.steps.map((s) => [s.id, s]));
    const run: WorkflowRun = {
      ...pausedRun,
      status: 'running',
      // O14: errors 反映「本次尝试」的失败。resume 是一次全新尝试——若沿用旧
      // run 的 errors，恢复成功也会被误判为 failed（结尾按 errors 计算状态）。
      errors: [],
      continuityId: pausedRun.continuityId ?? pausedRun.id,
      ...(options?.goalId ? { goalId: options.goalId } : pausedRun.goalId ? { goalId: pausedRun.goalId } : {}),
      ...(options?.projectId ? { projectId: options.projectId } : pausedRun.projectId ? { projectId: pausedRun.projectId } : {}),
      ...(options?.planVersion !== undefined ? { planVersion: options.planVersion } : pausedRun.planVersion !== undefined ? { planVersion: pausedRun.planVersion } : {}),
      ...(options?.runVersion !== undefined ? { runVersion: options.runVersion } : pausedRun.runVersion !== undefined ? { runVersion: pausedRun.runVersion } : {}),
      ...(pausedRun.projectRules
        ? { projectRules: pausedRun.projectRules }
        : options?.projectRules
          ? { projectRules: options.projectRules }
          : {}),
      // O13: 显式传入的新绑定优先；否则沿用 checkpoint 中记录的绑定。
      ...(options?.providerBinding
        ? { providerBinding: options.providerBinding }
        : pausedRun.providerBinding
          ? { providerBinding: pausedRun.providerBinding }
          : {}),
    };
    // O14: resume 本身就是一种 checkpoint 恢复——除非调用方显式关闭，
    // 步骤请求默认携带 resumeFromCheckpoint: true。
    const effectiveOptions: WorkflowRunOptions = {
      resumeFromCheckpoint: true,
      ...options,
      checkpointRun: options?.checkpointRun ?? pausedRun,
    };

    for (let i = fromIndex; i < order.length; i++) {
      const stepId = order[i];
      if (!stepId) continue;
      const step = stepMap.get(stepId);
      if (!step) continue;

      if (applyRequestedControl(run, stepId, effectiveOptions)) {
        await this.publishCheckpoint(definition, run, hooks);
        return run;
      }

      const deps = definition.dependencies[stepId];
      // Skipped steps (user chose "skip" on an escalated step) count as
      // satisfied so downstream steps can still run.
      const allDepsComplete = deps?.every((dep: string) =>
        run.stepResults[dep]?.status === 'completed'
        || (
          run.stepResults[dep]?.status === 'skipped'
          && run.stepResults[dep]?.skipReason === 'human_decision'
        )) ?? true;

      const existingResult = this.getOrCreateStepResult(run, stepId);

      // O14: 已完成的步骤不重跑（checkpoint 语义），保留输出供下游引用。
      if (existingResult.status === 'completed') {
        continue;
      }

      if (!allDepsComplete) {
        run.stepResults[stepId] = { ...existingResult, status: 'skipped', skipReason: 'dependency_unmet' };
        continue;
      }

      run.currentStepId = stepId;
      run.stepResults[stepId] = { ...existingResult, status: 'running', startedAt: Date.now() };

      if (hooks?.onStepStart) await hooks.onStepStart(step, run);
      await this.publishCheckpoint(definition, run, hooks);

      const upstreamOutputs = collectUpstreamOutputs(step, run.stepResults);
      const result = await this.executeStep(run, definition, hooks, step, upstreamOutputs, run.input, liveSteering, effectiveOptions);

      run.stepResults[stepId] = {
        ...run.stepResults[stepId]!,
        agentResult: result.agentResult,
        retryCount: result.retryCount,
      };

      if (applyRequestedControl(run, stepId, effectiveOptions, { pauseAtBoundaryOnly: true })) {
        await this.publishCheckpoint(definition, run, hooks);
        return run;
      }

      run.stepResults[stepId] = {
        ...run.stepResults[stepId]!,
        status: result.status === 'completed' ? 'completed' : 'failed',
        output: result.output,
        completedAt: Date.now(),
      };

      const updatedResult = run.stepResults[stepId]!;
      await this.publishCheckpoint(definition, run, hooks);

      if (result.status === 'completed') {
        if (hooks?.onStepComplete) await hooks.onStepComplete(step, updatedResult, run);
      } else {
        // O7: accumulate failure reasons and escalate to a human decision
        // (retry / skip / stop) after the configured threshold, mirroring
        // mission-control's loop-detection policy. Until resolved the run
        // pauses rather than burning more attempts or silently failing.
        const priorReasons = run.stepResults[stepId]?.failureReasons ?? [];
        const attemptReason = result.failureReasons ?? [`步骤「${step.name}」执行失败（尝试 ${updatedResult.retryCount + 1}）`];
        updatedResult.failureReasons = [...priorReasons, ...attemptReason];
        run.stepResults[stepId] = updatedResult;

        if (updatedResult.retryCount + 1 >= STEP_FAILURE_ESCALATION_THRESHOLD) {
          updatedResult.decisionRequired = true;
          run.status = 'paused';
          run.errors.push(`步骤「${step.name}」连续失败 ${updatedResult.retryCount + 1} 次，等待人工决策（重试/跳过/停止）`);
          run.currentStepId = stepId;
          if (hooks?.onStepFailed) await hooks.onStepFailed(step, updatedResult, run);
          await this.publishCheckpoint(definition, run, hooks);
          return run;
        }
        run.errors.push(`Step '${step.name}' (${stepId}) failed`);
        if (hooks?.onStepFailed) await hooks.onStepFailed(step, updatedResult, run);
        await this.publishCheckpoint(definition, run, hooks);
      }
    }

    run.status = run.errors.length === 0 ? 'completed' : 'failed';
    run.completedAt = Date.now();
    run.currentStepId = null;
    await this.publishCheckpoint(definition, run, hooks);
    return run;
  }

  // ─── Helpers ─────────────────────────────────────────────────

  private getOrCreateStepResult(run: WorkflowRun, stepId: string): StepResult {
    const existing = run.stepResults[stepId];
    if (existing) return existing;
    const fresh: StepResult = {
      stepId,
      status: 'pending',
      output: '',
      agentResult: null,
      startedAt: 0,
      completedAt: null,
      retryCount: 0,
    };
    run.stepResults[stepId] = fresh;
    return fresh;
  }

  // ─── Step Execution ─────────────────────────────────────────

  private async executeStep(
    run: WorkflowRun,
    definition: WorkflowDefinition,
    hooks: WorkflowHooks | undefined,
    step: WorkflowStep,
    upstreamOutputs: Record<string, string>,
    globalInput: Record<string, unknown>,
    liveSteering?: import('../runtime/LiveSteeringContract.js').LiveSteeringSource,
    options?: WorkflowRunOptions,
  ): Promise<{ status: 'completed' | 'failed'; output: string; agentResult: AgentRunResult; retryCount: number; failureReasons?: string[] }> {
    const maxRetries = step.retry?.maxRetries ?? 0;
    let retryCount = 0;

    while (retryCount <= maxRetries) {
      const prompt = buildStepPrompt(step, upstreamOutputs, globalInput, retryCount > 0 ? step.retry?.onFailPrompt : undefined);
      const checkpointContext = buildCheckpointResumeContext(run, options?.checkpointRun, step.id);

      const request: AgentRunRequest = {
        sessionId: `wf-step-${step.id}`,
        messages: [
          // O13: 项目级系统提示（覆盖全局）注入到步骤消息最前。
          ...(options?.providerBinding?.systemPrompt
            ? [{ role: 'system' as const, content: options.providerBinding.systemPrompt }]
            : []),
          ...(run.projectRules
            ? [{
              role: 'system' as const,
              content: formatProjectRulesContext(run.projectRules),
              metadata: {
                projectMetis: true,
                projectId: run.projectRules.projectId,
                projectMetisVersion: run.projectRules.version,
                projectMetisContentHash: run.projectRules.contentHash,
                contextPin: true,
              },
            }]
            : []),
          ...(checkpointContext ? [checkpointContext] : []),
          { role: 'user', content: prompt },
        ],
        allowedTools: step.tools.length > 0 ? step.tools : undefined,
        // Floor of 6 turns: tool-using steps need turn headroom (reason → call
        // → observe → answer). The previous planner default of 3 truncated
        // final steps mid-tool-call with max_turns_reached.
        maxTurns: Math.min(Math.max(step.maxTurns ?? 6, 6), 20),
        taskContractHash: '',
        promptStackHash: '',
        // O14: 不再硬编码 false——由执行选项决定（checkpoint 恢复时为 true）。
        resumeFromCheckpoint: options?.resumeFromCheckpoint ?? false,
        requestId: `wf-${step.id}-${Date.now()}`,
        toolEffectScope: `${run.continuityId ?? run.id}:${step.id}`,
        replayToolEffects: this.getReplayToolEffects(run, options?.checkpointRun, step.id),
        onToolEffect: async (effect) => {
          const currentStep = this.getOrCreateStepResult(run, step.id);
          const effects = currentStep.toolEffects ?? [];
          if (!effects.some((existing) => existing.idempotencyKey === effect.idempotencyKey)) {
            currentStep.toolEffects = [...effects, effect];
          }
          await this.publishCheckpoint(definition, run, hooks);
        },
        ...(options?.projectId ? { projectId: options.projectId } : {}),
        ...(options?.providerBinding ? { providerProfileBinding: options.providerBinding } : {}),
        ...(liveSteering ? { liveSteering } : {}),
        ...(options?.control ? { signal: options.control.signal } : {}),
      };

      const agentResult = await this.agent.run(request);

      // A step only counts as completed when the run finished cleanly AND the
      // output is a real accomplishment: verified run (no internal errors),
      // non-empty text, and not an agent-declared inability ("我无法…",
      // "please paste the text for me", …). Refusals that sneak through as
      // final answers previously marked steps completed with finalVerified
      // true — undermining the runtime's research-integrity guarantee.
      const output = agentResult.finalText ?? '';
      const accomplished = agentResult.status === 'completed'
        && agentResult.finalVerified === true
        && output.trim().length > 0
        && !isNonAccomplishmentOutput(output);

      // O6: objective acceptance criteria. Even when the agent claims
      // completion, deterministic checks (min length, must-contain, must-not-
      // contain, regex) must also pass; otherwise treat as a failure and retry.
      if (accomplished && hasAcceptanceCriteria(step.acceptanceCriteria)) {
        const check = evaluateAcceptanceCriteria(output, step.acceptanceCriteria);
        if (!check.passed) {
          // Append the failure reasons to the retry prompt so the next attempt
          // knows what was missing, then loop.
          if (retryCount < maxRetries) {
            retryCount++;
            continue;
          }
          return {
            status: 'failed',
            output,
            agentResult,
            retryCount,
            failureReasons: check.failures,
          };
        }
      }

      if (accomplished) {
        return {
          status: 'completed',
          output,
          agentResult,
          retryCount,
        };
      }

      retryCount++;
      if (retryCount > maxRetries) {
        const reason = isNonAccomplishmentOutput(output)
          ? ['输出为拒答或非实绩内容']
          : (agentResult.status !== 'completed'
            ? [`执行未正常结束（status=${agentResult.status}）`]
            : ['输出为空或未通过完成校验']);
        return {
          status: 'failed',
          output: agentResult.finalText ?? '',
          agentResult,
          retryCount: retryCount - 1,
          failureReasons: reason,
        };
      }
    }

    // Should not reach here, but just in case
    throw new Error(`Unexpected state in step execution: ${step.id}`);
  }

  /** Return only effects already checkpointed for this logical Step, de-duplicated by key. */
  private getReplayToolEffects(
    run: WorkflowRun,
    checkpointRun: WorkflowRun | undefined,
    stepId: string,
  ): ToolEffectSnapshot[] {
    const effects = [
      ...(checkpointRun?.stepResults[stepId]?.toolEffects ?? []),
      ...(run.stepResults[stepId]?.toolEffects ?? []),
    ];
    return Array.from(new Map(effects.map((effect) => [effect.idempotencyKey, effect])).values());
  }

  /** Recompute the durable recovery payload before notifying its persistence owner. */
  private async publishCheckpoint(
    definition: WorkflowDefinition,
    run: WorkflowRun,
    hooks?: WorkflowHooks,
  ): Promise<void> {
    const checkpoint = buildWorkflowCheckpoint(definition, run);
    run.checkpoint = checkpoint;
    if (hooks?.onCheckpoint) await hooks.onCheckpoint(run, checkpoint);
  }
}

/**
 * Apply a Goal-owned control request to the durable WorkflowRun. Pause is a
 * boundary operation: if the current step has already returned successfully,
 * its result is persisted first and the next loop boundary performs the pause.
 * Cancel is immediate and intentionally preserves the current step ID so the
 * history truthfully shows where work stopped.
 */
function applyRequestedControl(
  run: WorkflowRun,
  stepId: string,
  options?: WorkflowRunOptions,
  behavior: { pauseAtBoundaryOnly?: boolean } = {},
): boolean {
  const state = options?.control?.getState() ?? 'running';
  if (state === 'running') return false;
  // An ordinary user pause waits for a successful Step boundary. A controlled
  // process shutdown aborts the in-flight request, so it must checkpoint the
  // interrupted Step immediately instead of recording that interruption as a
  // normal Step failure and then closing the persistence store.
  if (state === 'pause_requested' && behavior.pauseAtBoundaryOnly && !options?.control?.signal.aborted) return false;

  run.status = state === 'cancel_requested' ? 'cancelled' : 'paused';
  run.currentStepId = stepId;
  if (state === 'cancel_requested') run.completedAt = Date.now();
  return true;
}

/**
 * Materialize the versioned recovery payload from the live run. The referenced
 * agent history stays in `stepResults[stepId].agentResult.messages`, which is
 * persisted with the same run; this avoids a second divergent context store.
 */
export function buildWorkflowCheckpoint(
  definition: WorkflowDefinition,
  run: WorkflowRun,
): WorkflowCheckpoint {
  const order = topologicalSort(definition);
  const completedStepIds = order.filter((stepId) => run.stepResults[stepId]?.status === 'completed');
  const pendingStepIds = order.filter((stepId) => {
    const status = run.stepResults[stepId]?.status;
    return status !== 'completed' && status !== 'skipped';
  });
  const pendingDecisionStepIds = order.filter((stepId) => run.stepResults[stepId]?.decisionRequired === true);
  const effects = Array.from(new Map(
    Object.values(run.stepResults)
      .flatMap((result) => result.toolEffects ?? [])
      .map((effect) => [effect.idempotencyKey, effect]),
  ).values());
  const artifactIds = new Set<string>();
  let contextSnapshot: WorkflowCheckpoint['contextSnapshot'];

  const resultsByRecency = Object.values(run.stepResults)
    .filter((result) => result.agentResult !== null)
    .sort((a, b) => (b.completedAt ?? b.startedAt) - (a.completedAt ?? a.startedAt));
  const contextResult = resultsByRecency[0];
  if (contextResult?.agentResult) {
    const summarySourceRanges = contextResult.agentResult.messages.flatMap((message) => {
      const metadata = message.metadata ?? {};
      if (metadata.contextCompressionSummary !== true) return [];
      const firstMessageIndex = metadata.sourceFirstMessageIndex;
      const lastMessageIndex = metadata.sourceLastMessageIndex;
      const messageCount = metadata.summarizedCount;
      if (
        typeof firstMessageIndex !== 'number'
        || typeof lastMessageIndex !== 'number'
        || typeof messageCount !== 'number'
      ) return [];
      return [{ firstMessageIndex, lastMessageIndex, messageCount }];
    });
    contextSnapshot = {
      runId: run.id,
      stepId: contextResult.stepId,
      source: 'agent_result_messages',
      messageCount: contextResult.agentResult.messages.length,
      summarySourceRanges,
    };
    for (const message of contextResult.agentResult.messages) collectArtifactIds(message.metadata, artifactIds);
  }
  for (const effect of effects) collectArtifactIds(effect.result.metadata, artifactIds);

  const recoveryStrategy: WorkflowCheckpoint['recoveryStrategy'] = pendingDecisionStepIds.length > 0
    ? 'await_human_decision'
    : run.status === 'cancelled'
      ? 'terminal_cancelled'
      : run.status === 'failed'
        ? 'retry_current_step'
        : 'resume_pending_step';
  const errorCategory: WorkflowCheckpoint['errorCategory'] = run.status === 'cancelled'
    ? 'cancelled'
    : run.status === 'paused'
      ? 'paused'
      : run.status === 'failed'
        ? 'step_failed'
        : undefined;

  return {
    version: 1,
    capturedAt: Date.now(),
    workflowId: definition.id,
    workflowVersion: definition.version,
    ...(run.planVersion !== undefined ? { planVersion: run.planVersion } : {}),
    ...(run.runVersion !== undefined ? { runVersion: run.runVersion } : {}),
    ...(run.projectRules ? {
      projectRules: {
        projectId: run.projectRules.projectId,
        version: run.projectRules.version,
        contentHash: run.projectRules.contentHash,
      },
    } : {}),
    continuityId: run.continuityId ?? run.id,
    ...(run.goalId ? { goalId: run.goalId } : {}),
    ...(run.projectId ? { projectId: run.projectId } : {}),
    currentStepId: run.currentStepId,
    completedStepIds,
    pendingStepIds,
    pendingDecisionStepIds,
    artifactIds: Array.from(artifactIds),
    toolEffectKeys: effects.map((effect) => effect.idempotencyKey),
    ...(contextSnapshot ? { contextSnapshot } : {}),
    ...(errorCategory ? { errorCategory } : {}),
    recoveryStrategy,
  };
}

function formatProjectRulesContext(rules: import('./types.js').WorkflowProjectRulesSnapshot): string {
  return [
    `以下是项目「${rules.projectId}」在本次 Goal 运行开始时冻结的 Metis.md（版本 ${rules.version}，摘要 ${rules.contentHash}）。`,
    '它是项目级研究约束；执行与恢复都必须基于此版本，不要用之后编辑的规则替换它。',
    rules.markdown,
  ].join('\n\n');
}

function collectArtifactIds(metadata: Record<string, unknown> | undefined, target: Set<string>): void {
  if (!metadata) return;
  if (typeof metadata.artifactId === 'string') target.add(metadata.artifactId);
  if (Array.isArray(metadata.artifactIds)) {
    for (const id of metadata.artifactIds) if (typeof id === 'string') target.add(id);
  }
}

const MAX_CHECKPOINT_RESUME_CONTEXT_CHARS = 12_000;

/**
 * Re-inject the persisted context of an interrupted/failed Step as a pinned
 * system message. This is a faithful, bounded extract from the Agent history,
 * not a fabricated summary; real semantic summaries remain identifiable by
 * their original metadata inside the referenced run.
 */
function buildCheckpointResumeContext(
  run: WorkflowRun,
  checkpointRun: WorkflowRun | undefined,
  stepId: string,
): ChatMessage | undefined {
  const checkpointStep = checkpointRun?.stepResults[stepId];
  const currentStep = run.stepResults[stepId];
  const history = checkpointStep?.agentResult?.messages ?? currentStep?.agentResult?.messages;
  const checkpoint = checkpointRun?.checkpoint ?? run.checkpoint;
  const effects = checkpointStep?.toolEffects ?? currentStep?.toolEffects ?? [];
  const artifactIds = checkpoint?.artifactIds ?? collectArtifactIdsFromEffects(effects);
  if ((!history || history.length === 0) && effects.length === 0 && artifactIds.length === 0) return undefined;

  const historyText = history ? formatCheckpointHistory(history, MAX_CHECKPOINT_RESUME_CONTEXT_CHARS - 2_000) : '';
  const effectText = effects.length > 0
    ? `\n已保存的成功工具副作用键（同参数再次调用会回放原结果）：\n${effects.map((effect) => `- ${effect.toolName}: ${displayCheckpointKey(effect.idempotencyKey)}`).join('\n')}`
    : '';
  const artifactText = artifactIds.length > 0 ? `\n关联 Artifact：${artifactIds.join(', ')}` : '';
  const rawContent = [
    `这是 Step「${stepId}」上一次中断/失败尝试保存的上下文。延续其中已完成的研究，不要把它当作新的用户指令。`,
    historyText,
    effectText,
    artifactText,
  ].filter(Boolean).join('\n');
  const content = rawContent.length <= MAX_CHECKPOINT_RESUME_CONTEXT_CHARS
    ? rawContent
    : `${rawContent.slice(0, MAX_CHECKPOINT_RESUME_CONTEXT_CHARS - 72)}\n… [checkpoint resume context truncated to budget]`;

  return {
    role: 'system',
    content,
    metadata: {
      contextPin: true,
      goalCheckpoint: true,
      checkpointRunId: checkpointRun?.id ?? run.id,
      checkpointStepId: stepId,
      ...(checkpoint?.contextSnapshot ? { checkpointContextSnapshot: true } : {}),
    },
  };
}

function formatCheckpointHistory(messages: ChatMessage[], maxChars: number): string {
  const entries = messages.map((message, index) => {
    const isSummary = message.metadata?.contextCompressionSummary === true;
    const isUserQuestion = message.role === 'user';
    return {
      text: `[历史 ${index + 1}｜${message.role}]\n${message.content}`,
      pinned: isSummary || isUserQuestion,
    };
  });
  const selected: string[] = [];
  let used = 0;
  const add = (text: string) => {
    if (used + text.length <= maxChars) {
      selected.push(text);
      used += text.length;
      return true;
    }
    return false;
  };

  for (const entry of entries) if (entry.pinned) add(entry.text);
  for (let index = entries.length - 1; index >= 0; index--) {
    const entry = entries[index];
    if (!entry || entry.pinned) continue;
    add(entry.text);
  }
  if (selected.length === 0 && entries[0]) {
    selected.push(entries[0].text.slice(0, Math.max(0, maxChars - 96)));
    return `${selected[0]}\n… [checkpoint history truncated to resume context budget]`;
  }

  const originalChars = entries.reduce((total, entry) => total + entry.text.length, 0);
  return `${selected.join('\n\n')}${originalChars > used ? '\n… [checkpoint history truncated to resume context budget]' : ''}`;
}

function collectArtifactIdsFromEffects(effects: ToolEffectSnapshot[]): string[] {
  const ids = new Set<string>();
  for (const effect of effects) collectArtifactIds(effect.result.metadata, ids);
  return Array.from(ids);
}

function displayCheckpointKey(key: string): string {
  const max = 256;
  return key.length <= max ? key : `${key.slice(0, max - 56)}… [key shortened in prompt; full key is persisted]`;
}

// ─── Helpers ──────────────────────────────────────────────────

/**
 * O14: 从 checkpoint（上次持久化的 WorkflowRun）推导恢复点——拓扑序中第一个
 * 未完成的步骤。全部完成时返回 null（无需恢复）。GoalEngine.resumeGoal 用它
 * 实现「从上次断点继续」而不是从 0 重来。
 */
export function findCheckpointResumeStep(
  definition: WorkflowDefinition,
  checkpointRun: WorkflowRun,
): string | null {
  const order = topologicalSort(definition);
  for (const stepId of order) {
    if (checkpointRun.stepResults[stepId]?.status !== 'completed') {
      return stepId;
    }
  }
  return null;
}

/** O14: 判断一个 run 是否留有可恢复的 checkpoint（至少一步已完成且有未完成步骤）。 */
export function hasResumableCheckpoint(
  definition: WorkflowDefinition,
  run: WorkflowRun | null | undefined,
): boolean {
  if (!run) return false;
  const results = Object.values(run.stepResults);
  const hasCompleted = results.some((r) => r.status === 'completed');
  return hasCompleted && findCheckpointResumeStep(definition, run) !== null;
}

/**
 * Detect agent outputs that declare inability instead of accomplishing the
 * step task. Only fires when the refusal dominates the answer: the pattern
 * must appear near the start and the whole output must stay short — a long
 * answer that mentions a limitation in passing (or quotes one) still counts
 * as an accomplishment.
 */
export function isNonAccomplishmentOutput(text: string): boolean {
  const trimmed = text.trim();
  if (!trimmed || trimmed.length > 500) return false;
  const head = trimmed.slice(0, 300);
  const refusalPatterns: RegExp[] = [
    /我(目前)?无法(直接|实际)?(访问|调用|创建|完成|读取|执行|检索|搜索)/u,
    /(当前)?环境中没有(提供)?[^。.\n]{0,30}工具/u,
    /没有(提供|可用)[^。.\n]{0,30}工具/u,
    /请(你|您)(将|把)[^。.\n]{0,40}(粘贴|提供|发)给?我/u,
    /我(无法|不能)(为你|帮您|帮助你)/u,
    /I('m| am) unable to (access|call|create|read|complete)/i,
    /I can(not|'t) (directly )?(access|call|create|read)/i,
    /I do(n't| not) have access to/i,
  ];
  return refusalPatterns.some((pattern) => pattern.test(head));
}

function collectUpstreamOutputs(
  step: WorkflowStep,
  stepResults: Record<string, StepResult>,
): Record<string, string> {
  const outputs: Record<string, string> = {};

  for (const inputId of step.inputFrom) {
    const result = stepResults[inputId];
    if (result?.status === 'completed') {
      outputs[inputId] = result.output;
    }
  }

  return outputs;
}

function buildStepPrompt(
  step: WorkflowStep,
  upstreamOutputs: Record<string, string>,
  globalInput: Record<string, unknown>,
  retryPrompt?: string,
): string {
  let prompt = step.prompt;

  // Replace {{stepId.output}} placeholders
  for (const [stepId, output] of Object.entries(upstreamOutputs)) {
    prompt = prompt.replace(new RegExp(`\\{\\{${stepId}\\.output\\}\\}`, 'g'), output);
  }

  // Replace {{input.key}} placeholders
  for (const [key, value] of Object.entries(globalInput)) {
    prompt = prompt.replace(new RegExp(`\\{\\{input\\.${key}\\}\\}`, 'g'), String(value));
  }

  // Append retry prompt if needed
  if (retryPrompt) {
    prompt += `\n\n---\nPrevious attempt failed. ${retryPrompt}`;
  }

  return prompt;
}
