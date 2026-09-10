/**
 * AutonomousResearchEngine — integration tests for the while-not-done loop.
 *
 * Uses a stubbed WorkflowEngine (so no real AgentLoop/tools needed) and a
 * deterministic planner to verify: linear completion, reflection-driven redo,
 * live-steering interrupt, checkpoint persistence, and event emission.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { AutonomousResearchEngine } from '../../engine/research/AutonomousResearchEngine.js';
import { AutonomousPlanner } from '../../engine/research/AutonomousPlanner.js';
import { ResearchEventBus, type ResearchEvent } from '../../engine/research/ResearchEventBus.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import type {
  WorkflowDefinition,
  WorkflowRun,
  WorkflowHooks,
  WorkflowRunOptions,
} from '../../engine/workflow/types.js';

// ─── Stub WorkflowEngine ──────────────────────────────────────

class StubWorkflowEngine {
  /** Configurable per-phase output. */
  public outputs: Partial<Record<string, string>> = {};
  /** Throw on the Nth run call (simulates phase failure). */
  public failOnRun: number | null = null;
  /** Workflows that should keep failing until the test clears the set. */
  public failWorkflowIds = new Set<string>();
  /** Simulated phase duration so pause requests can land mid-run. */
  public delayMs = 0;
  private runCount = 0;
  public hooksSnapshot: WorkflowHooks | null = null;
  /** Workflow ids in execution order (used by strategy tests). */
  public executedIds: string[] = [];
  /** First-step prompts in execution order. */
  public executedPrompts: string[] = [];
  /** Execution options in order, including project scope. */
  public runOptions: Array<WorkflowRunOptions | undefined> = [];

  async run(
    definition: WorkflowDefinition,
    _input: Record<string, unknown>,
    hooks?: WorkflowHooks,
    _liveSteering?: unknown,
    options?: WorkflowRunOptions,
  ): Promise<WorkflowRun> {
    this.runCount += 1;
    this.executedIds.push(definition.id);
    this.executedPrompts.push(definition.steps[0]?.prompt ?? '');
    this.runOptions.push(options);
    this.hooksSnapshot = hooks ?? null;
    if (this.delayMs > 0) {
      await new Promise((resolve) => setTimeout(resolve, this.delayMs));
    }
    if (this.failOnRun === this.runCount || this.failWorkflowIds.has(definition.id)) {
      throw new Error(`stub failure on run ${this.runCount}`);
    }
    // Drive hooks so event coverage is exercised.
    for (const step of definition.steps) {
      await hooks?.onStepStart?.(step, {} as WorkflowRun);
      await hooks?.onStepComplete?.(step, { stepId: step.id, status: 'completed', output: 'step output', agentResult: null, startedAt: 0, completedAt: 1, retryCount: 0 }, {} as WorkflowRun);
    }
    const lastStep = definition.steps[definition.steps.length - 1];
    const output = this.outputs[definition.id] ?? `${definition.id}-output`;
    const run: WorkflowRun = {
      id: `run-${this.runCount}`,
      workflowId: definition.id,
      status: 'completed',
      currentStepId: lastStep?.id ?? null,
      stepResults: { [lastStep!.id]: { stepId: lastStep!.id, status: 'completed', output, agentResult: null, startedAt: 0, completedAt: 1, retryCount: 0 } },
      startedAt: 0,
      completedAt: 1,
      input: _input,
      errors: [],
    };
    return run;
  }
}

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-auto-test-'));
}

describe('AutonomousResearchEngine', () => {
  let dataDir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    store = new PersistenceStore(path.join(dataDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('automatically selects and completes a general humanities/social-science method plan', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner(); // no provider → deterministic advance
    const bus = new ResearchEventBus();
    const events: ResearchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub matches the run() contract sufficiently
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
    });

    const outcome = await engine.run('study X', 'sess-1');

    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(8);
    expect(outcome.methodSpec?.family).toBe('general');
    expect(Object.keys(outcome.phaseOutputs).sort()).toEqual([
      'analysis',
      'argumentation',
      'literature_review',
      'quality_audit',
      'question_formulation',
      'source_discovery',
      'triangulation',
      'writing',
    ]);
    // The full selected method is visible through live events.
    const types = events.map((e) => e.type);
    expect(types).toContain('engine-started');
    expect(types.filter((t) => t === 'phase-started')).toHaveLength(8);
    expect(types.filter((t) => t === 'reflection')).toHaveLength(8);
    const progressEvents = events.filter((event) => event.type === 'progress');
    expect(progressEvents).toHaveLength(8);
    expect(progressEvents.at(-1)).toMatchObject({ completedPhases: 8, totalPhases: 8 });
    const started = events.find((event) => event.type === 'engine-started');
    expect(started && started.type === 'engine-started' ? started.method?.family : undefined).toBe('general');
    expect(types).toContain('engine-completed');
  });

  it('clears the recovery checkpoint after a successful completed run', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
    });

    await engine.run('goal', 'sess-cp');

    expect(engine.loadCheckpoint('sess-cp')).toBeNull();
  });

  it('publishes only artifact ids confirmed by the durable artifact sink', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    const persistedIds: string[] = [];
    const events: ResearchEvent[] = [];
    bus.subscribe((event) => events.push(event));
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
      artifactSink: {
        persistPhaseOutput(input) {
          const id = `artifact-${input.phase}`;
          persistedIds.push(id);
          return id;
        },
        listArtifactIds() {
          return [...persistedIds];
        },
      },
    });

    const outcome = await engine.run('goal', 'sess-artifacts', 'project-1');

    expect(outcome.status).toBe('completed');
    expect(outcome.artifactIds).toHaveLength(8);
    expect(outcome.artifactIds).toContain('artifact-writing');
    expect(stub.runOptions).toHaveLength(8);
    expect(stub.runOptions.every((options) => options?.projectId === 'project-1')).toBe(true);
    const completed = events.find((event) => event.type === 'engine-completed');
    expect(completed && completed.type === 'engine-completed' ? completed.artifactIds : [])
      .toEqual(outcome.artifactIds);
  });

  it('fails recoverably instead of claiming completion when phase output cannot be saved', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    const events: ResearchEvent[] = [];
    let attempts = 0;
    bus.subscribe((event) => events.push(event));
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
      artifactSink: {
        persistPhaseOutput() {
          attempts += 1;
          throw new Error('disk unavailable');
        },
        listArtifactIds() {
          return [];
        },
      },
    });

    const outcome = await engine.run('goal', 'sess-artifact-failure', 'project-1');

    expect(attempts).toBe(3);
    expect(outcome.status).toBe('failed');
    expect(outcome.failureReason).toContain('连续保存失败');
    expect(events.some((event) => event.type === 'engine-completed')).toBe(false);
    expect(events.some((event) => event.type === 'engine-failed')).toBe(true);
    expect(engine.loadCheckpoint('sess-artifact-failure')?.history).toHaveLength(0);
  });

  it('handles phase execution failure by redoing then completing', async () => {
    const stub = new StubWorkflowEngine();
    stub.failOnRun = 1; // first phase (idea) throws once
    // Use a planner that advances so the redo doesn't loop forever.
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
    });

    const outcome = await engine.run('goal', 'sess-fail');

    // The first method phase failed once, retried autonomously, then all 8 phases completed.
    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(9);
  });

  it('stops when interrupted via the engine API', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
    });

    // Interrupt before the first phase can complete.
    const runPromise = engine.run('goal', 'sess-int');
    engine.interrupt('sess-int', 'test');
    const outcome = await runPromise;

    expect(outcome.status).toBe('interrupted');
    expect(outcome.iterations).toBeLessThan(4);
  });

  it('stops when live-steering queue yields an event between phases', async () => {
    const stub = new StubWorkflowEngine();
    const planner = new AutonomousPlanner();
    const bus = new ResearchEventBus();
    let drainCalls = 0;
    const liveSteering = {
      drain: async () => {
        drainCalls += 1;
        // After phase 1, return a valid explicit interrupt event.
        return drainCalls === 2 ? [{
          id: 'interrupt-1',
          type: 'interrupt',
          sessionId: 'sess-ls',
          sequence: 1,
          createdAt: Date.now(),
          reason: 'test interrupt',
        }] : [];
      },
    };
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      // @ts-expect-error minimal live-steering stub
      liveSteering,
      store,
    });

    const outcome = await engine.run('goal', 'sess-ls');

    expect(outcome.status).toBe('interrupted');
  });

  it('respects maxPhaseExecutions cap', async () => {
    const stub = new StubWorkflowEngine();
    // Planner that always redos idea → would loop forever without the cap.
    const alwaysRedoProvider = {
      complete: async () => ({ content: JSON.stringify({ decision: 'redo', qualityScore: 0.2, reasoning: 'never good enough', revisionNote: 'again' }) }),
      capabilities: () => ({ providerType: 'stub', model: 'm', nativeToolCalling: false, jsonSchemaOutput: false, streaming: false, thinking: false, maxContextTokens: 1000, maxOutputTokens: 100, retryableStatusCodes: [] }),
    };
    const planner = new AutonomousPlanner({ provider: alwaysRedoProvider as never, maxRedosPerPhase: 100 });
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner,
      eventBus: bus,
      store,
      maxPhaseExecutions: 5,
    });

    const outcome = await engine.run('goal', 'sess-cap');
    expect(outcome.iterations).toBeLessThanOrEqual(5);
    expect(outcome.status).toBe('failed');
  });
});

describe('AutonomousResearchEngine pause/resume state machine', () => {
  let dataDir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    store = new PersistenceStore(path.join(dataDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  it('pauses at the next phase boundary, persists a paused checkpoint, and resumes from it', async () => {
    const stub = new StubWorkflowEngine();
    stub.delayMs = 20;
    const bus = new ResearchEventBus();
    const events: ResearchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner: new AutonomousPlanner(),
      eventBus: bus,
      store,
    });

    const runPromise = engine.run('study X', 'sess-pause');
    // Request the pause while the first phase is executing; the loop honors it
    // at the next phase boundary.
    setTimeout(() => { engine.pause('sess-pause'); }, 25);
    const outcome = await runPromise;

    expect(outcome.status).toBe('paused');
    expect(outcome.iterations).toBeGreaterThan(0);
    expect(outcome.iterations).toBeLessThan(8);
    // The paused run emits engine-paused, never engine-completed.
    expect(events.some((e) => e.type === 'engine-paused')).toBe(true);
    expect(events.some((e) => e.type === 'engine-completed')).toBe(false);

    // The checkpoint records the full plan + paused marker for continuation.
    const checkpoint = engine.loadCheckpoint('sess-pause');
    expect(checkpoint).not.toBeNull();
    expect(checkpoint?.state).toBe('paused');
    expect(checkpoint?.phases.length).toBeGreaterThan(0);
    expect(checkpoint?.history.length).toBe(outcome.iterations);
    expect(checkpoint?.goal).toBe('study X');
  });

  it('resumes with a fresh engine and does NOT re-execute completed phases', async () => {
    const stub = new StubWorkflowEngine();
    stub.delayMs = 20;
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner: new AutonomousPlanner(),
      eventBus: bus,
      store,
    });
    const runPromise = engine.run('study X', 'sess-resume');
    setTimeout(() => { engine.pause('sess-resume'); }, 25);
    const paused = await runPromise;
    expect(paused.status).toBe('paused');
    const completedBeforePause = paused.iterations;

    // "Restart": a brand new engine + fresh workflow stub over the same store.
    const stub2 = new StubWorkflowEngine();
    const bus2 = new ResearchEventBus();
    const events2: ResearchEvent[] = [];
    bus2.subscribe((e) => events2.push(e));
    const engine2 = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub2,
      planner: new AutonomousPlanner(),
      eventBus: bus2,
      store,
    });

    const resumed = await engine2.resume('sess-resume');

    expect(resumed.status).toBe('completed');
    // Only the remaining phases executed — completed ones were not replayed.
    expect(stub2.runCount).toBe(8 - completedBeforePause);
    expect(resumed.iterations).toBe(8);
    // resume broadcasts its own transition event.
    expect(events2.some((e) => e.type === 'engine-resumed')).toBe(true);
    expect(events2.some((e) => e.type === 'engine-completed')).toBe(true);
    // The full output set is carried over from the checkpoint.
    expect(Object.keys(resumed.phaseOutputs)).toHaveLength(8);
  });

  it('rejects resume for sessions without a checkpoint', async () => {
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: new StubWorkflowEngine(),
      planner: new AutonomousPlanner(),
      eventBus: new ResearchEventBus(),
      store,
    });
    await expect(engine.resume('sess-unknown')).rejects.toThrow(/No checkpoint/u);
  });

  it('pause is ignored for sessions that are not running', async () => {
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: new StubWorkflowEngine(),
      planner: new AutonomousPlanner(),
      eventBus: new ResearchEventBus(),
      store,
    });
    expect(engine.pause('sess-idle')).toBe(false);
  });
});

describe('AutonomousResearchEngine user-defined strategies', () => {
  let dataDir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dataDir = tempDir();
    store = new PersistenceStore(path.join(dataDir, 'test.db'));
  });

  afterEach(() => {
    store.close();
    try { fs.rmSync(dataDir, { recursive: true, force: true }); } catch { /* ignore */ }
  });

  const strategy = (overrides: Partial<import('../../engine/runtime/ResearchStrategyContract.js').ResearchStrategy> = {}): import('../../engine/runtime/ResearchStrategyContract.js').ResearchStrategy => ({
    id: 'strategy-test',
    name: '混合研究策略',
    description: '综述 → 编码 → 论证 → 写作',
    phases: [
      { action: 'literature_review', name: '文献综述' },
      { action: 'coding', name: '质性编码' },
      { action: 'argumentation', name: '论证构建' },
      { action: 'writing', name: '论文写作' },
    ],
    createdAt: 1,
    updatedAt: 1,
    isDefault: false,
    ...overrides,
  });

  it('executes strategy phases in the user-defined order', async () => {
    const stub = new StubWorkflowEngine();
    const bus = new ResearchEventBus();
    const events: ResearchEvent[] = [];
    bus.subscribe((e) => events.push(e));
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner: new AutonomousPlanner(),
      eventBus: bus,
      store,
    });

    const outcome = await engine.runWithStrategy('研究目标', 'sess-strategy', strategy());

    expect(outcome.status).toBe('completed');
    expect(outcome.iterations).toBe(4);
    // The executed workflow ids follow the strategy phase sequence.
    const executedIds = stub.executedIds;
    expect(executedIds).toEqual([
      'action_literature_review_1',
      'action_coding_2',
      'action_argumentation_3',
      'action_writing_4',
    ]);
    expect(Object.keys(outcome.phaseOutputs).sort()).toEqual([
      'argumentation',
      'coding',
      'literature_review',
      'writing',
    ]);
  });

  it('pauses a strategy run at a phase boundary and resumes without re-executing completed phases', async () => {
    const stub = new StubWorkflowEngine();
    stub.delayMs = 20;
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner: new AutonomousPlanner(),
      eventBus: bus,
      store,
    });
    const runPromise = engine.runWithStrategy('目标', 'sess-strategy-pause', strategy());
    setTimeout(() => { engine.pause('sess-strategy-pause'); }, 25);
    const paused = await runPromise;
    expect(paused.status).toBe('paused');

    // Fresh engine resumes from the checkpoint and skips completed phases.
    const stub2 = new StubWorkflowEngine();
    const engine2 = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub2,
      planner: new AutonomousPlanner(),
      eventBus: new ResearchEventBus(),
      store,
    });
    const resumed = await engine2.resume('sess-strategy-pause');
    expect(resumed.status).toBe('completed');
    expect(stub2.executedIds.length).toBe(4 - paused.iterations);
    expect(resumed.iterations).toBe(4);
  });

  it('retries a failed strategy phase instead of silently skipping its research output', async () => {
    const stub = new StubWorkflowEngine();
    stub.failOnRun = 2; // second phase throws
    const bus = new ResearchEventBus();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner: new AutonomousPlanner(),
      eventBus: bus,
      store,
    });
    const outcome = await engine.runWithStrategy('目标', 'sess-strategy-fail', strategy());
    expect(outcome.status).toBe('completed');
    expect(outcome.phaseOutputs.coding).toBe('action_coding_2-output');
    expect(stub.executedIds.filter((id) => id === 'action_coding_2')).toHaveLength(2);
    expect(stub.executedIds[0]).toBe('action_literature_review_1');
    expect(stub.executedIds[stub.executedIds.length - 1]).toBe('action_writing_4');
  });

  it('absorbs a live instruction into the next phase without interrupting the run', async () => {
    const stub = new StubWorkflowEngine();
    let drains = 0;
    const liveSteering = {
      drain: async () => {
        drains += 1;
        return drains === 2 ? [{
          id: 'instruction-1',
          type: 'instruction',
          sessionId: 'sess-instruction',
          sequence: 1,
          createdAt: Date.now(),
          content: '优先检查反例和地方性差异',
        }] : [];
      },
    };
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner: new AutonomousPlanner(),
      eventBus: new ResearchEventBus(),
      // @ts-expect-error minimal queue
      liveSteering,
      store,
    });

    const outcome = await engine.runWithStrategy('目标', 'sess-instruction', strategy());

    expect(outcome.status).toBe('completed');
    expect(stub.executedPrompts[1]).toContain('优先检查反例和地方性差异');
  });

  it('inserts and executes a missing research branch discovered by reflection without confirmation', async () => {
    const responses = [
      { decision: 'advance', nextPhase: 'source_criticism', qualityScore: 0.8, reasoning: '需要先审查材料形成背景。' },
      { decision: 'advance', nextPhase: 'coding', qualityScore: 0.9, reasoning: '史料边界已明确。' },
      { decision: 'advance', nextPhase: 'argumentation', qualityScore: 0.9, reasoning: '编码充分。' },
      { decision: 'advance', nextPhase: 'writing', qualityScore: 0.9, reasoning: '论证可写作。' },
      { decision: 'done', qualityScore: 0.95, reasoning: '方法计划完成。' },
    ];
    let call = 0;
    const provider = {
      complete: async () => ({ content: JSON.stringify(responses[Math.min(call++, responses.length - 1)]) }),
      capabilities: () => ({
        providerType: 'stub', model: 'm', nativeToolCalling: false, jsonSchemaOutput: false,
        streaming: false, thinking: false, maxContextTokens: 1000, maxOutputTokens: 100,
        retryableStatusCodes: [],
      }),
    };
    const stub = new StubWorkflowEngine();
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner: new AutonomousPlanner({ provider: provider as never }),
      eventBus: new ResearchEventBus(),
      store,
    });

    const outcome = await engine.runWithStrategy('目标', 'sess-branch', strategy());

    expect(outcome.status).toBe('completed');
    expect(stub.executedIds).toEqual([
      'action_literature_review_1',
      'action_source_criticism_1',
      'action_coding_2',
      'action_argumentation_3',
      'action_writing_4',
    ]);
    expect(outcome.phaseOutputs.source_criticism).toBeTruthy();
  });

  it('reports a persistent phase failure honestly and resumes from its checkpoint after recovery', async () => {
    const stub = new StubWorkflowEngine();
    stub.failWorkflowIds.add('action_literature_review_1');
    const events: ResearchEvent[] = [];
    const bus = new ResearchEventBus();
    bus.subscribe((event) => events.push(event));
    const engine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: stub,
      planner: new AutonomousPlanner(),
      eventBus: bus,
      store,
      maxFailuresPerPhase: 1,
    });

    const failed = await engine.runWithStrategy('目标', 'sess-recover', strategy());

    expect(failed.status).toBe('failed');
    expect(failed.failureReason).toContain('自主重试 1 次后仍失败');
    expect(events.some((event) => event.type === 'engine-failed')).toBe(true);
    expect(engine.loadCheckpoint('sess-recover')?.failureReason).toBe(failed.failureReason);

    const recoveredStub = new StubWorkflowEngine();
    const recoveredEngine = new AutonomousResearchEngine({
      // @ts-expect-error stub
      workflowEngine: recoveredStub,
      planner: new AutonomousPlanner(),
      eventBus: new ResearchEventBus(),
      store,
      maxFailuresPerPhase: 1,
    });
    const recovered = await recoveredEngine.resume('sess-recover');

    expect(recovered.status).toBe('completed');
    expect(recovered.iterations).toBe(6); // two failed attempts + four successful phases
    expect(recovered.phaseOutputs.literature_review).toBeTruthy();
  });
});
