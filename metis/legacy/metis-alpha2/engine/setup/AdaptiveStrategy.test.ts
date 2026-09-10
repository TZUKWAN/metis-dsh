/**
 * METIS-303 — Adaptive execution strategy tests.
 *
 * Verifies a 9B-class model gets the fine-grained "small" profile (more turns, forced
 * structured output, frequent review), while a powerful model gets a coarser profile. Also
 * covers downgrade-on-failure and unusable model handling.
 */

import { describe, it, expect } from 'vitest';
import { classifyModelTier, deriveAdaptiveStrategy, downgradeStrategy } from './AdaptiveStrategy.js';
import type { ProbedCapabilities } from './CapabilityProbe.js';

function probe(over: Partial<ProbedCapabilities>): ProbedCapabilities {
  return {
    reachable: true, streaming: true, nativeToolCalling: true, jsonOutput: true,
    maxContextTokens: 128000, multimodal: false, ...over,
  };
}

describe('METIS-303 AdaptiveStrategy — tier classification', () => {
  it('classifies ≤8k as micro', () => {
    expect(classifyModelTier(probe({ maxContextTokens: 4096 }))).toBe('micro');
    expect(classifyModelTier(probe({ maxContextTokens: 8192 }))).toBe('micro');
  });
  it('classifies 9B-class (8k–32k) as small', () => {
    expect(classifyModelTier(probe({ maxContextTokens: 32768 }))).toBe('small');
    expect(classifyModelTier(probe({ maxContextTokens: 16384 }))).toBe('small');
  });
  it('classifies 32k–128k as standard', () => {
    expect(classifyModelTier(probe({ maxContextTokens: 64000 }))).toBe('standard');
  });
  it('classifies >128k as powerful', () => {
    expect(classifyModelTier(probe({ maxContextTokens: 200000 }))).toBe('powerful');
  });
  it('classifies unreachable as unusable', () => {
    expect(classifyModelTier(probe({ reachable: false }))).toBe('unusable');
  });
});

describe('METIS-303 AdaptiveStrategy — 9B model gets fine-grained profile', () => {
  const smallProbe = probe({ maxContextTokens: 32768, nativeToolCalling: true, jsonOutput: true });
  const strategy = deriveAdaptiveStrategy(smallProbe);

  it('small tier with more turns per step than a powerful model', () => {
    expect(strategy.tier).toBe('small');
    const powerful = deriveAdaptiveStrategy(probe({ maxContextTokens: 200000 }));
    expect(strategy.maxTurnsPerStep).toBeGreaterThan(powerful.maxTurnsPerStep);
  });

  it('forces structured output for deterministic parsing', () => {
    expect(strategy.forceStructuredOutput).toBe(true);
  });

  it('reviews frequently (every 2 turns, not 4)', () => {
    expect(strategy.reviewEveryNTurns).toBeLessThanOrEqual(2);
  });

  it('limits tools per turn (router bound respected)', () => {
    expect(strategy.maxToolsPerTurn).toBeLessThanOrEqual(12);
    expect(strategy.maxToolsPerTurn).toBeGreaterThanOrEqual(5);
  });

  it('context budget is bounded below raw context (leaves headroom)', () => {
    expect(strategy.contextBudgetTokens).toBeLessThan(32768);
  });

  it('every strategy carries an explanatory rationale (METIS-303 explainability)', () => {
    expect(strategy.rationale.length).toBeGreaterThan(10);
  });
});

describe('METIS-303 AdaptiveStrategy — powerful model profile', () => {
  it('larger steps, less forced structure, less frequent review', () => {
    const s = deriveAdaptiveStrategy(probe({ maxContextTokens: 200000, jsonOutput: true }));
    expect(s.tier).toBe('powerful');
    expect(s.maxTurnsPerStep).toBeLessThanOrEqual(3);
    expect(s.forceStructuredOutput).toBe(false);
    expect(s.maxOutputTokens).toBeGreaterThanOrEqual(8192);
  });
});

describe('METIS-303 AdaptiveStrategy — no native tool calling', () => {
  it('reports nativeToolCalling=false so the loop parses tool calls from text', () => {
    const s = deriveAdaptiveStrategy(probe({ maxContextTokens: 32768, nativeToolCalling: false }));
    expect(s.nativeToolCalling).toBe(false);
  });
});

describe('METIS-303 AdaptiveStrategy — unusable model', () => {
  it('returns the unusable profile with zero capacity', () => {
    const s = deriveAdaptiveStrategy(probe({ reachable: false }));
    expect(s.tier).toBe('unusable');
    expect(s.maxTurnsPerStep).toBe(0);
    expect(s.maxToolsPerTurn).toBe(0);
  });
});

describe('METIS-303 AdaptiveStrategy — downgrade on failure', () => {
  it('downgrades standard -> small with finer grain + every-turn review', () => {
    const standard = deriveAdaptiveStrategy(probe({ maxContextTokens: 64000 }));
    const down = downgradeStrategy(standard);
    expect(down.tier).toBe('small');
    expect(down.maxTurnsPerStep).toBeGreaterThan(standard.maxTurnsPerStep);
    expect(down.reviewEveryNTurns).toBe(1);
    expect(down.forceStructuredOutput).toBe(true);
  });

  it('downgrade at micro is a no-op (cannot go lower)', () => {
    const micro = deriveAdaptiveStrategy(probe({ maxContextTokens: 4096 }));
    const down = downgradeStrategy(micro);
    expect(down.tier).toBe('micro');
  });
});
