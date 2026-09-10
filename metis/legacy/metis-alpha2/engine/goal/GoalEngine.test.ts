/**
 * Tests for GoalEngine — Goal-Driven Plan+Workflow 一体化引擎。
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import { GoalEngine } from './GoalEngine.js';
import type { Goal } from './GoalPlanner.js';
import type { AgentLoop } from '../core/AgentLoop.js';
import type { AgentRunRequest, AgentRunResult } from '../core/types.js';
import type { GoalPersistence } from './GoalPersistence.js';
import type { WorkflowDefinition, WorkflowRun } from '../workflow/types.js';

// ─── Mock AgentLoop ───────────────────────────────────────────

function createMinimalWorkflowJson(name: string): string {
  return JSON.stringify({
    id: 'wf_agent',
    name,
    description: 'Agent-generated workflow',
    version: '1.0',
    steps: [
      { id: 's1', name: 'Step 1', description: 'D', prompt: 'P', inputFrom: [], tools: [], maxTurns: 3 },
    ],
    dependencies: { s1: [] },
  });
}

function createMockAgentLoop(): AgentLoop {
  return {
    run: vi.fn(async (req: AgentRunRequest): Promise<AgentRunResult> => {
      const isPlanning = req.sessionId.startsWith('plan-');
      const isRefinement = req.sessionId.startsWith('refine-');
      const finalText = isPlanning
        ? createMinimalWorkflowJson('Agent Plan')
        : isRefinement
          ? createMinimalWorkflowJson('Refined Agent Plan')
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

function createFailingMockAgentLoop(): AgentLoop {
  return {
    run: vi.fn(async (req: AgentRunRequest): Promise<AgentRunResult> => {
      return {
        status: 'completed',
        finalText: `Result for ${req.sessionId}`,
        finalVerified: true,
        messages: [{ role: 'assistant', content: `Result for ${req.sessionId}` }],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        errors: [],
        traceEvents: [],
      } as AgentRunResult;
    }),
  } as unknown as AgentLoop;
}

// ─── Tests ────────────────────────────────────────────────────

describe('GoalEngine', () => {
  let agent: AgentLoop;
  let engine: GoalEngine;

  beforeEach(() => {
    agent = createMockAgentLoop();
    engine = new GoalEngine(agent);
  });

  // ── Goal Lifecycle ─────────────────────────────────────────

  it('creates a goal with correct initial state', () => {
    const goal = engine.createGoal('Analyze paper methodology');
    expect(goal.description).toBe('Analyze paper methodology');
    expect(goal.status).toBe('draft');
    expect(goal.id).toMatch(/^goal_\d+/);
    expect(goal.createdAt).toBeGreaterThan(0);
  });

  it('retrieves a goal by id', () => {
    const goal = engine.createGoal('Test goal');
    const retrieved = engine.getGoal(goal.id);
    expect(retrieved).toBeDefined();
    expect(retrieved?.id).toBe(goal.id);
  });

  it('returns undefined for non-existent goal', () => {
    expect(engine.getGoal('non-existent')).toBeUndefined();
  });

  it('lists goals sorted by createdAt desc', async () => {
    const g1 = engine.createGoal('First');
    await new Promise((r) => setTimeout(r, 10));
    const g2 = engine.createGoal('Second');
    const list = engine.listGoals();
    expect(list.length).toBe(2);
    expect(list[0]!.id).toBe(g2.id);
    expect(list[1]!.id).toBe(g1.id);
  });

  // ── Plan Generation ────────────────────────────────────────

  it('generates a plan for a goal', async () => {
    const goal = engine.createGoal('Write a literature review about transformers');
    const result = await engine.generatePlan(goal.id);

    expect(result.goal.status).toBe('ready');
    expect(result.workflow.steps.length).toBeGreaterThan(0);
    expect(result.workflow.dependencies).toBeDefined();
    expect(result.reasoning).toContain('Generated');
  });

  it('throws when generating plan for non-existent goal', async () => {
    await expect(engine.generatePlan('non-existent')).rejects.toThrow("not found");
  });

  it('selects literature review template for review goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Literature review on neural networks');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.name.toLowerCase()).toContain('literature');
    expect(result.workflow.steps.length).toBeGreaterThanOrEqual(4);
  });

  it('selects analysis template for analysis goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Analyze the methodology of this paper');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.name.toLowerCase()).toContain('analysis');
  });

  it('selects writing template for writing goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Write a research paper draft');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.name.toLowerCase()).toContain('writing');
  });

  it('selects experiment template for experiment goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Design an experiment to test hypothesis');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.name.toLowerCase()).toContain('experiment');
  });

  it('selects generic template for unmatched goals', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Do some research');
    const result = await fallbackEngine.generatePlan(goal.id);
    expect(result.workflow.steps.length).toBeGreaterThan(0);
  });

  // ── Plan Refinement ────────────────────────────────────────

  it('refines a plan based on feedback', async () => {
    const goal = engine.createGoal('Write a paper');
    await engine.generatePlan(goal.id);

    const refined = await engine.refinePlan(goal.id, 'Add more detail to the methodology section');
    expect(refined.goal.status).toBe('ready');
    expect(refined.workflow.steps.length).toBeGreaterThan(0);
  });

  it('throws when refining non-existent goal', async () => {
    await expect(engine.refinePlan('non-existent', 'feedback')).rejects.toThrow("not found");
  });

  it('extracts JSON from markdown code block when generating plan', async () => {
    const fencedEngine = new GoalEngine({
      run: vi.fn(async (): Promise<AgentRunResult> => ({
        status: 'completed',
        finalText: `Here is the plan:\n\n\`\`\`json\n${createMinimalWorkflowJson('Fenced Plan')}\n\`\`\``,
        finalVerified: true,
        messages: [],
        turnsUsed: 1,
        toolResults: [],
        usage: { promptTokens: 10, completionTokens: 10, totalTokens: 20 },
        errors: [],
        traceEvents: [],
      } as AgentRunResult)),
    } as unknown as AgentLoop);
    const goal = fencedEngine.createGoal('Any goal');
    const result = await fencedEngine.generatePlan(goal.id);
    expect(result.workflow.name).toBe('Fenced Plan');
    expect(result.reasoning).toContain('LLM agent');
  });

  it('falls back to step append when refinement returns non-JSON', async () => {
    const fallbackEngine = new GoalEngine(createFailingMockAgentLoop());
    const goal = fallbackEngine.createGoal('Write a paper');
    await fallbackEngine.generatePlan(goal.id);

    const refined = await fallbackEngine.refinePlan(goal.id, 'Add more detail');
    expect(refined.goal.status).toBe('ready');
    expect(refined.workflow.steps.some((s) => s.name.includes('Feedback'))).toBe(true);
  });

  // ── Plan Update ────────────────────────────────────────────

  it('updates a plan directly', () => {
    const goal = engine.createGoal('Test');
    const plan = {
      id: 'wf_test',
      name: 'Test Workflow',
      description: 'Test',
      version: '1.0',
      steps: [
        { id: 's1', name: 'Step 1', description: 'D', prompt: 'P', inputFrom: [], tools: [], maxTurns: 3 },
      ],
      dependencies: { s1: [] },
    };

    const validation = engine.updatePlan(goal.id, plan);
    expect(validation.valid).toBe(true);
    expect(goal.status).toBe('ready');
  });

  it('rejects invalid plan update', () => {
    const goal = engine.createGoal('Test');
    const plan = {
      id: 'wf_test',
      name: 'Test',
      description: 'Test',
      version: '1.0',
      steps: [],
      dependencies: {},
    };

    const validation = engine.updatePlan(goal.id, plan);
    expect(validation.valid).toBe(false);
    expect(validation.errors.length).toBeGreaterThan(0);
  });

  // ── Goal Execution ─────────────────────────────────────────

  it('executes a goal and marks it completed', async () => {
    const goal = engine.createGoal('Analyze methodology');
    await engine.generatePlan(goal.id);

    const run = await engine.executeGoal(goal.id);
    expect(run.status).toBe('completed');
    expect(goal.status).toBe('completed');
  });

  it('tracks progress during execution', async () => {
    const goal = engine.createGoal('Write literature review');
    await engine.generatePlan(goal.id);
    await engine.executeGoal(goal.id);

    const progress = engine.getProgress(goal.id);
    expect(progress).toBeDefined();
    expect(progress!.status).toBe('completed');
    expect(progress!.totalSteps).toBeGreaterThan(0);
    expect(progress!.completedSteps).toBeGreaterThan(0);
  });

  it('archives a completed goal', async () => {
    const goal = engine.createGoal('Analyze paper');
    await engine.generatePlan(goal.id);
    await engine.executeGoal(goal.id);

    const archive = await engine.archiveGoal(goal.id);
    expect(archive.goal.id).toBe(goal.id);
    expect(archive.summary).toContain(goal.description);
    expect(archive.archivedAt).toBeGreaterThan(0);
  });

  it('lists archives', async () => {
    const goal = engine.createGoal('Test archive');
    await engine.generatePlan(goal.id);
    await engine.executeGoal(goal.id);
    // executeGoal auto-archives on completion; don't call archiveGoal again

    const archives = engine.getArchives();
    expect(archives.length).toBe(1);
    expect(archives[0]!.goal.description).toBe('Test archive');
  });

  it('calls hooks during execution', async () => {
    const goal = engine.createGoal('Test hooks');
    await engine.generatePlan(goal.id);

    const onStepStart = vi.fn();
    const onStepComplete = vi.fn();

    await engine.executeGoal(goal.id, {
      onStepStart,
      onStepComplete,
    });

    expect(onStepStart).toHaveBeenCalled();
    expect(onStepComplete).toHaveBeenCalled();
  });

  // ── Goal Cancellation ──────────────────────────────────────

  it('cancels a running goal', () => {
    const goal = engine.createGoal('Cancel me');
    expect(engine.cancelGoal(goal.id)).toBe(true);
    expect(goal.status).toBe('cancelled');
  });

  it('does not turn a completed goal into a cancelled goal', async () => {
    const goal = engine.createGoal('Completed goal remains terminal');
    await engine.generatePlan(goal.id);
    const run = await engine.executeGoal(goal.id);

    expect(run.status).toBe('completed');
    expect(engine.cancelGoal(goal.id)).toBe(false);
    expect(goal.status).toBe('completed');
  });

  it('records stable plan and execution revisions on each persisted attempt', async () => {
    const goal = engine.createGoal('Versioned goal', undefined, 'project-versioned');
    expect(goal.planVersion).toBe(0);
    expect(goal.runVersion).toBe(0);

    const firstPlan = await engine.generatePlan(goal.id);
    expect(goal.planVersion).toBe(1);
    expect(engine.updatePlan(goal.id, { ...firstPlan.workflow, version: '1.1' }).valid).toBe(true);
    expect(goal.planVersion).toBe(2);

    const firstRun = await engine.executeGoal(goal.id);
    expect(firstRun.planVersion).toBe(2);
    expect(firstRun.runVersion).toBe(1);
    expect(firstRun.checkpoint?.planVersion).toBe(2);
    expect(firstRun.checkpoint?.runVersion).toBe(1);
    expect(goal.runVersion).toBe(1);
  });

  it('pauses at a step boundary and resumes from the saved checkpoint', async () => {
    const goal = engine.createGoal('Pause and resume');
    const workflow: WorkflowDefinition = {
      id: 'wf_pause', name: 'Pause workflow', description: '', version: '1',
      steps: [
        { id: 'first', name: 'First', description: '', prompt: 'first', inputFrom: [], tools: [], maxTurns: 1 },
        { id: 'second', name: 'Second', description: '', prompt: 'second', inputFrom: ['first'], tools: [], maxTurns: 1 },
      ],
      dependencies: { first: [], second: ['first'] },
    };
    expect(engine.updatePlan(goal.id, workflow).valid).toBe(true);

    const paused = await engine.executeGoal(goal.id, {
      onStepComplete: (step) => {
        if (step.id === 'first') expect(engine.pauseGoal(goal.id)).toBe(true);
      },
    });

    expect(paused.status).toBe('paused');
    expect(goal.status).toBe('paused');
    expect(paused.currentStepId).toBe('second');
    expect(paused.stepResults.first?.status).toBe('completed');
    expect(paused.stepResults.second?.status).toBe('pending');

    const resumed = await engine.resumeGoal(goal.id);
    expect(resumed.status).toBe('completed');
    expect(goal.status).toBe('completed');
    expect(resumed.stepResults.first?.status).toBe('completed');
    expect(resumed.stepResults.second?.status).toBe('completed');
  });

  it('refuses to resume a checkpoint after its Goal plan has changed', async () => {
    const goal = engine.createGoal('Do not resume stale plan');
    const workflow: WorkflowDefinition = {
      id: 'wf_stale', name: 'Stale workflow', description: '', version: '1',
      steps: [
        { id: 'first', name: 'First', description: '', prompt: 'first', inputFrom: [], tools: [], maxTurns: 1 },
        { id: 'second', name: 'Second', description: '', prompt: 'second', inputFrom: ['first'], tools: [], maxTurns: 1 },
      ],
      dependencies: { first: [], second: ['first'] },
    };
    expect(engine.updatePlan(goal.id, workflow).valid).toBe(true);
    const paused = await engine.executeGoal(goal.id, {
      onStepComplete: (step) => {
        if (step.id === 'first') engine.pauseGoal(goal.id);
      },
    });
    expect(paused.status).toBe('paused');
    expect(engine.updatePlan(goal.id, { ...workflow, version: '2' }).valid).toBe(true);

    await expect(engine.resumeGoal(goal.id)).rejects.toThrow('plan changed');
  });

  it('cancels an active AgentLoop request instead of recording a failure', async () => {
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const interruptibleAgent = {
      run: vi.fn(async (request: AgentRunRequest): Promise<AgentRunResult> => {
        started?.();
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return {
          status: 'interrupted', finalText: '', finalVerified: false, messages: [], turnsUsed: 0,
          toolResults: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, errors: [], traceEvents: [],
        };
      }),
    } as unknown as AgentLoop;
    const interruptibleEngine = new GoalEngine(interruptibleAgent);
    const goal = interruptibleEngine.createGoal('Cancel active run');
    const workflow: WorkflowDefinition = {
      id: 'wf_cancel', name: 'Cancel workflow', description: '', version: '1',
      steps: [{ id: 'work', name: 'Work', description: '', prompt: 'work', inputFrom: [], tools: [], maxTurns: 1 }],
      dependencies: { work: [] },
    };
    expect(interruptibleEngine.updatePlan(goal.id, workflow).valid).toBe(true);

    const execution = interruptibleEngine.executeGoal(goal.id);
    await startedPromise;
    expect(interruptibleEngine.cancelGoal(goal.id)).toBe(true);
    const run = await execution;

    expect((interruptibleAgent.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(run.status).toBe('cancelled');
    expect(goal.status).toBe('cancelled');
    expect(run.stepResults.work?.status).toBe('running');
  });

  it('does not resurrect or archive a Goal when cancellation races with late completion', async () => {
    const lateAgent = createMockAgentLoop();
    const lateEngine = new GoalEngine(lateAgent);
    const goal = lateEngine.createGoal('Cancel after step completion');
    const workflow: WorkflowDefinition = {
      id: 'wf_cancel_race', name: 'Cancel race workflow', description: '', version: '1',
      steps: [{ id: 'work', name: 'Work', description: '', prompt: 'work', inputFrom: [], tools: [], maxTurns: 1 }],
      dependencies: { work: [] },
    };
    expect(lateEngine.updatePlan(goal.id, workflow).valid).toBe(true);

    const run = await lateEngine.executeGoal(goal.id, {
      onStepComplete: () => {
        // Simulate a user cancel arriving after the provider returned a successful
        // result but before GoalEngine finalization persisted the terminal run.
        expect(lateEngine.cancelGoal(goal.id)).toBe(true);
      },
    });

    expect(run.status).toBe('cancelled');
    expect(goal.status).toBe('cancelled');
    expect(lateEngine.getArchives()).toHaveLength(0);
    expect(lateEngine.getProgress(goal.id)?.status).toBe('cancelled');
  });

  it('suspends an active Goal for host shutdown without recording a failure', async () => {
    let started: (() => void) | undefined;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const interruptibleAgent = {
      run: vi.fn(async (request: AgentRunRequest): Promise<AgentRunResult> => {
        started?.();
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return {
          status: 'interrupted', finalText: '', finalVerified: false, messages: [{ role: 'assistant', content: 'partial research evidence' }], turnsUsed: 1,
          toolResults: [], usage: { promptTokens: 1, completionTokens: 1, totalTokens: 2 }, errors: [], traceEvents: [],
        };
      }),
    } as unknown as AgentLoop;
    const interruptibleEngine = new GoalEngine(interruptibleAgent);
    const goal = interruptibleEngine.createGoal('Suspend active run for shutdown');
    const workflow: WorkflowDefinition = {
      id: 'wf_shutdown', name: 'Shutdown workflow', description: '', version: '1',
      steps: [{ id: 'work', name: 'Work', description: '', prompt: 'work', inputFrom: [], tools: [], maxTurns: 1 }],
      dependencies: { work: [] },
    };
    expect(interruptibleEngine.updatePlan(goal.id, workflow).valid).toBe(true);

    const execution = interruptibleEngine.executeGoal(goal.id);
    await startedPromise;
    interruptibleEngine.suspendActiveGoalsForShutdown();
    const run = await execution;

    expect((interruptibleAgent.run as ReturnType<typeof vi.fn>).mock.calls[0]?.[0].signal.aborted).toBe(true);
    expect(run.status).toBe('paused');
    expect(goal.status).toBe('paused');
    expect(run.currentStepId).toBe('work');
    expect(run.stepResults.work?.agentResult?.messages[0]?.content).toBe('partial research evidence');
  });

  it('drains active Goals and rejects new executions after shutdown begins', async () => {
    let started!: () => void;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const interruptibleAgent = {
      run: vi.fn(async (request: AgentRunRequest): Promise<AgentRunResult> => {
        started();
        await new Promise<void>((resolve) => request.signal?.addEventListener('abort', () => resolve(), { once: true }));
        return {
          status: 'interrupted', finalText: '', finalVerified: false, messages: [], turnsUsed: 0,
          toolResults: [], usage: { promptTokens: 0, completionTokens: 0, totalTokens: 0 }, errors: [], traceEvents: [],
        };
      }),
    } as unknown as AgentLoop;
    const drainingEngine = new GoalEngine(interruptibleAgent);
    const goal = drainingEngine.createGoal('Drain this Goal');
    const workflow: WorkflowDefinition = {
      id: 'wf_drain', name: 'Drain workflow', description: '', version: '1',
      steps: [{ id: 'work', name: 'Work', description: '', prompt: 'work', inputFrom: [], tools: [], maxTurns: 1 }],
      dependencies: { work: [] },
    };
    expect(drainingEngine.updatePlan(goal.id, workflow).valid).toBe(true);
    const execution = drainingEngine.executeGoal(goal.id);
    await startedPromise;
    const drain = drainingEngine.drainActiveRuns(1000);
    await expect(execution).resolves.toMatchObject({ status: 'paused' });
    await expect(drain).resolves.toEqual({ timedOut: false, pending: [] });
    const newGoal = drainingEngine.createGoal('Do not start after drain');
    expect(drainingEngine.updatePlan(newGoal.id, workflow).valid).toBe(true);
    await expect(drainingEngine.executeGoal(newGoal.id)).rejects.toThrow('shutting down');
  });

  it('turns a persisted running Goal into a recoverable paused checkpoint after restart', () => {
    const workflow: WorkflowDefinition = {
      id: 'wf_restart', name: 'Restart workflow', description: '', version: '1',
      steps: [{ id: 'work', name: 'Work', description: '', prompt: 'work', inputFrom: [], tools: [], maxTurns: 1 }],
      dependencies: { work: [] },
    };
    const run: WorkflowRun = {
      id: 'run_restart', workflowId: workflow.id, status: 'running', currentStepId: 'work',
      stepResults: { work: { stepId: 'work', status: 'running', output: '', agentResult: null, startedAt: 1, completedAt: null, retryCount: 0 } },
      startedAt: 1, completedAt: null, input: {}, errors: [],
    };
    const persistedGoal = {
      id: 'goal_restart', description: 'Recover after restart', createdAt: 1, status: 'running' as const,
    } as unknown as Goal;
    const persistence: GoalPersistence = {
      loadGoals: () => [{ goal: persistedGoal, plan: workflow, run }],
      loadArchives: () => [],
      saveGoal: vi.fn(), savePlan: vi.fn(), saveRun: vi.fn(), saveArchive: vi.fn(), deleteGoal: vi.fn(),
    };

    const restarted = new GoalEngine(createMockAgentLoop(), undefined, persistence);
    expect(restarted.getGoal(persistedGoal.id)?.status).toBe('paused');
    expect(restarted.getGoal(persistedGoal.id)?.planVersion).toBe(1);
    expect(restarted.getGoal(persistedGoal.id)?.runVersion).toBe(1);
    expect(restarted.getCheckpointInfo(persistedGoal.id).runStatus).toBe('paused');
    expect(persistence.saveGoal).toHaveBeenCalledWith(expect.objectContaining({ id: persistedGoal.id, status: 'paused' }));
    expect(persistence.saveRun).toHaveBeenCalledWith(persistedGoal.id, expect.objectContaining({ status: 'paused' }));
  });

  // ── Goal with Context ──────────────────────────────────────

  it('creates goal with context', () => {
    const goal = engine.createGoal('Analyze paper', 'This is about transformer architectures');
    expect(goal.context).toBe('This is about transformer architectures');
  });
});
