/**
 * AutonomousPlanner — online reflective planner tests.
 *
 * Covers: initial plan shape, deterministic fallback, provider-driven reflection
 * (JSON + fenced JSON + malformed), redo cap enforcement, rollback revision.
 */

import { describe, it, expect } from 'vitest';
import { AutonomousPlanner, PHASE_ORDER } from '../../engine/research/AutonomousPlanner.js';
import { FakeProvider } from '../../engine/providers/FakeProvider.js';
import type { PhaseHistoryEntry } from '../../engine/research/AutonomousPlanner.js';

describe('AutonomousPlanner', () => {
  it('proposeInitialGoal builds a 4-phase linear plan', () => {
    const planner = new AutonomousPlanner();
    const plan = planner.proposeInitialGoal('研究 X');
    expect(plan.goal).toBe('研究 X');
    expect(plan.phases.map((p) => p.phase)).toEqual([...PHASE_ORDER]);
    expect(plan.phases[0]?.iteration).toBe(1);
  });

  it('proposeResearchPlan automatically builds a historical research chain', async () => {
    const planner = new AutonomousPlanner();
    const plan = await planner.proposeResearchPlan('利用档案和报刊研究民国时期城市救济制度的演变');

    expect(plan.methodSpec?.family).toBe('historical');
    expect(plan.phases.map((phase) => phase.phase)).toEqual(expect.arrayContaining([
      'source_discovery',
      'source_criticism',
      'triangulation',
      'quality_audit',
    ]));
    expect(plan.phases.some((phase) => phase.phase === 'experiment')).toBe(false);
  });

  it('pickNextPhase walks the plan in order and returns null when exhausted', () => {
    const planner = new AutonomousPlanner();
    const plan = planner.proposeInitialGoal('g');
    expect(planner.pickNextPhase(plan, [])?.phase).toBe('idea');
    const history: PhaseHistoryEntry[] = [
      { phase: 'idea', iteration: 1, output: 'a' },
    ];
    expect(planner.pickNextPhase(plan, history)?.phase).toBe('experiment');
    expect(planner.pickNextPhase(plan, [
      { phase: 'idea', iteration: 1, output: 'a' },
      { phase: 'experiment', iteration: 1, output: 'b' },
      { phase: 'analysis', iteration: 1, output: 'c' },
      { phase: 'paper', iteration: 1, output: 'd' },
    ])).toBeNull();
  });

  it('reflect returns done after paper phase without a provider (deterministic fallback)', async () => {
    const planner = new AutonomousPlanner();
    const reflection = await planner.reflect('paper', 'final manuscript', [], 'goal');
    expect(reflection.decision).toBe('done');
  });

  it('reflect advances linearly without a provider', async () => {
    const planner = new AutonomousPlanner();
    const reflection = await planner.reflect('idea', 'output', [], 'goal');
    expect(reflection.decision).toBe('advance');
    expect(reflection.nextPhase).toBe('experiment');
  });

  it('reflect uses provider JSON output to decide advance', async () => {
    const provider = new FakeProvider({
      response: JSON.stringify({
        decision: 'advance',
        qualityScore: 0.9,
        nextPhase: 'experiment',
        reasoning: '假设清晰且可验证',
      }),
    });
    const planner = new AutonomousPlanner({ provider });
    const reflection = await planner.reflect('idea', 'output', [], 'goal');
    expect(reflection.decision).toBe('advance');
    expect(reflection.nextPhase).toBe('experiment');
    expect(reflection.qualityScore).toBeCloseTo(0.9);
  });

  it('reflect parses fenced JSON output', async () => {
    const provider = new FakeProvider({
      response: '```json\n{"decision":"redo","qualityScore":0.4,"nextPhase":"idea","reasoning":"空白分析不充分","revisionNote":"补充更多 baseline"}\n```',
    });
    const planner = new AutonomousPlanner({ provider });
    const reflection = await planner.reflect('idea', 'output', [], 'goal');
    expect(reflection.decision).toBe('redo');
    expect(reflection.revisionNote).toContain('baseline');
  });

  it('reflect degrades to deterministic on malformed provider output', async () => {
    const provider = new FakeProvider({ response: '抱歉我无法处理。' });
    const planner = new AutonomousPlanner({ provider });
    const reflection = await planner.reflect('idea', 'output', [], 'goal');
    expect(reflection.decision).toBe('advance');
  });

  it('redo cap forces advancement after maxRedosPerPhase', async () => {
    const provider = new FakeProvider({
      response: JSON.stringify({ decision: 'redo', qualityScore: 0.3, reasoning: 'still bad', revisionNote: 'try again' }),
    });
    const planner = new AutonomousPlanner({ provider, maxRedosPerPhase: 2 });
    // Trigger redo twice (under cap) then a third (over cap → forced advance).
    const r1 = await planner.reflect('experiment', 'o', [], 'g');
    const r2 = await planner.reflect('experiment', 'o', [], 'g');
    const r3 = await planner.reflect('experiment', 'o', [], 'g');
    expect(r1.decision).toBe('redo');
    expect(r2.decision).toBe('redo');
    expect(r3.decision).toBe('advance');
    expect(r3.reasoning).toContain('强制推进');
  });

  it('reviseForRedo appends a redo phase with incremented iteration', () => {
    const planner = new AutonomousPlanner();
    const plan = planner.proposeInitialGoal('g');
    planner.reviseForRedo(plan, 'experiment', 'fix the bug');
    const experimentPhases = plan.phases.filter((p) => p.phase === 'experiment');
    expect(experimentPhases).toHaveLength(2);
    expect(experimentPhases[1]?.iteration).toBe(2);
    expect(plan.revisionNotes.experiment).toBe('fix the bug');
  });

  it('can insert a redo immediately at the execution cursor', () => {
    const planner = new AutonomousPlanner();
    const plan = planner.proposeInitialGoal('g');
    planner.reviseForRedo(plan, 'idea', '补足反例', 1);

    expect(plan.phases.map((phase) => phase.phase)).toEqual([
      'idea', 'idea', 'experiment', 'analysis', 'paper',
    ]);
    expect(plan.phases[1]?.name).toContain('重做');
  });

  it('preserves downstream method phases when rolling back', () => {
    const planner = new AutonomousPlanner();
    const plan = planner.proposeInitialGoal('g');
    const history: PhaseHistoryEntry[] = [
      { phase: 'idea', iteration: 1, output: 'a' },
      { phase: 'experiment', iteration: 2, output: 'b' },
      { phase: 'analysis', iteration: 3, output: 'c' },
    ];

    planner.reviseForRollback(plan, history, 'experiment', '修正设计');

    expect(history.map((entry) => entry.phase)).toEqual(['idea']);
    expect(plan.phases.map((phase) => phase.phase)).toEqual(['idea', 'experiment', 'analysis', 'paper']);
  });
});
