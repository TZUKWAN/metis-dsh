/**
 * METIS-102 — Unified Research Lifecycle state machine tests.
 *
 * Verifies the single source of truth for research-plan status transitions, including
 * the happy path, branch/retry semantics, and illegal-transition rejection.
 */

import { describe, it, expect } from 'vitest';
import {
  RESEARCH_LIFECYCLE_TRANSITIONS,
  canTransitionResearchLifecycle,
  assertResearchLifecycleTransition,
  isTerminalResearchLifecycle,
  type ResearchLifecycle,
} from '../../engine/core/types.js';

const ALL_STATES: ResearchLifecycle[] = [
  'draft', 'clarified', 'planned', 'approved', 'running', 'reviewing', 'completed', 'archived',
];

describe('METIS-102 ResearchLifecycle state machine', () => {
  // ── Happy-path forward progression ───────────────────────────────────────

  it('allows the canonical forward progression draft -> ... -> archived', () => {
    const happy: Array<[ResearchLifecycle, ResearchLifecycle]> = [
      ['draft', 'clarified'],
      ['clarified', 'planned'],
      ['planned', 'approved'],
      ['approved', 'running'],
      ['running', 'reviewing'],
      ['reviewing', 'completed'],
      ['completed', 'archived'],
    ];
    for (const [from, to] of happy) {
      expect(canTransitionResearchLifecycle(from, to), `${from} -> ${to}`).toBe(true);
    }
  });

  // ── Pause / retry / rollback / branch semantics ─────────────────────────

  it('supports retry/rollback from running back to planned or approved', () => {
    expect(canTransitionResearchLifecycle('running', 'planned')).toBe(true); // rollback to replan
    expect(canTransitionResearchLifecycle('running', 'approved')).toBe(true); // pause -> approved
  });

  it('supports request-changes from reviewing back to running', () => {
    expect(canTransitionResearchLifecycle('reviewing', 'running')).toBe(true);
    expect(canTransitionResearchLifecycle('reviewing', 'approved')).toBe(true); // reject plan output
  });

  it('supports re-opening a completed plan for revision', () => {
    expect(canTransitionResearchLifecycle('completed', 'reviewing')).toBe(true);
    expect(canTransitionResearchLifecycle('completed', 'running')).toBe(true);
  });

  it('allows clarifying again (clarified -> draft) when scope changes', () => {
    expect(canTransitionResearchLifecycle('clarified', 'draft')).toBe(true);
    expect(canTransitionResearchLifecycle('planned', 'clarified')).toBe(true);
  });

  it('allows archiving from any non-terminal state (cancel/abandon)', () => {
    for (const s of ALL_STATES) {
      if (s === 'archived') continue;
      expect(canTransitionResearchLifecycle(s, 'archived'), `${s} -> archived`).toBe(true);
    }
  });

  // ── Idempotent re-affirmation ───────────────────────────────────────────

  it('treats same-state transitions as legal (idempotent)', () => {
    for (const s of ALL_STATES) {
      expect(canTransitionResearchLifecycle(s, s), `${s} -> ${s}`).toBe(true);
    }
  });

  // ── Illegal transitions ─────────────────────────────────────────────────

  it('rejects skipping the approval gate (planned -> running is illegal)', () => {
    expect(canTransitionResearchLifecycle('planned', 'running')).toBe(false);
    expect(canTransitionResearchLifecycle('planned', 'reviewing')).toBe(false);
    expect(canTransitionResearchLifecycle('planned', 'completed')).toBe(false);
  });

  it('rejects drafting straight to running without clarification/planning', () => {
    expect(canTransitionResearchLifecycle('draft', 'running')).toBe(false);
    expect(canTransitionResearchLifecycle('draft', 'approved')).toBe(false);
    expect(canTransitionResearchLifecycle('draft', 'completed')).toBe(false);
  });

  it('allows leaving the archived state only to recoverable targets', () => {
    for (const s of ALL_STATES) {
      if (s === 'archived') continue; // 幂等自转移恒允许
      const expected = s === 'draft' || s === 'completed' || s === 'reviewing';
      expect(canTransitionResearchLifecycle('archived', s), `archived -> ${s}`).toBe(expected);
    }
    expect(isTerminalResearchLifecycle('archived')).toBe(true);
  });

  it('throws a descriptive error on illegal transitions via assert helper', () => {
    expect(() => assertResearchLifecycleTransition('draft', 'running')).toThrowError(/Illegal research lifecycle transition.*draft.*running/);
    // archived -> running 仍非法（只能恢复到 draft/completed/reviewing）。
    expect(() => assertResearchLifecycleTransition('archived', 'running')).toThrowError(/Illegal research lifecycle transition.*archived.*running/);
  });

  it('does not throw for legal transitions via assert helper', () => {
    expect(() => assertResearchLifecycleTransition('draft', 'clarified')).not.toThrow();
    expect(() => assertResearchLifecycleTransition('reviewing', 'completed')).not.toThrow();
  });

  // ── Machine completeness invariant ──────────────────────────────────────

  it('defines transitions for every canonical state (no missing keys)', () => {
    for (const s of ALL_STATES) {
      expect(RESEARCH_LIFECYCLE_TRANSITIONS[s], `transitions for ${s}`).toBeDefined();
      expect(Array.isArray(RESEARCH_LIFECYCLE_TRANSITIONS[s])).toBe(true);
    }
  });
});
