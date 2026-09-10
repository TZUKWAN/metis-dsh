/**
 * METIS-307 — One-sentence project creation tests.
 *
 * Covers: intent preserved verbatim; project starts at draft lifecycle; routing decides
 * clarify-vs-plan; empty input asks for clarification; four core scenario utterances each
 * create a project with a sensible next action.
 */

import { describe, it, expect } from 'vitest';
import { createProjectFromIntent } from './QuickStart.js';

const FIXED = { generateId: () => 'proj-fixed', now: () => 1000 };

describe('METIS-307 QuickStart — preserves intent & lifecycle', () => {
  it('preserves the original sentence verbatim', () => {
    const p = createProjectFromIntent('我想研究清代科举对社会流动的影响', FIXED);
    expect(p.originalIntent).toBe('我想研究清代科举对社会流动的影响');
  });

  it('starts every project at the draft lifecycle (METIS-102)', () => {
    const p = createProjectFromIntent('综述数字劳工研究', FIXED);
    expect(p.lifecycle).toBe('draft');
  });

  it('generates an id and timestamp', () => {
    const p = createProjectFromIntent('something', FIXED);
    expect(p.id).toBe('proj-fixed');
    expect(p.createdAt).toBe(1000);
  });

  it('derives a bounded title (≤ ~30 chars)', () => {
    const long = '这是一个非常非常非常非常非常非常非常非常非常长的研究意图描述'.repeat(2);
    const p = createProjectFromIntent(long, FIXED);
    expect(p.title.length).toBeLessThanOrEqual(31);
    expect(p.title.endsWith('…')).toBe(true);
  });
});

describe('METIS-307 QuickStart — clarify vs plan decision', () => {
  it('routes a clear single-domain intent to plan', () => {
    const p = createProjectFromIntent('用双重差分 DID 估计最低工资对就业的因果效应', FIXED);
    expect(p.nextAction.kind).toBe('plan');
  });

  it('routes an ambiguous/empty intent to clarify', () => {
    const p = createProjectFromIntent('   ', FIXED);
    expect(p.nextAction.kind).toBe('clarify');
    if (p.nextAction.kind === 'clarify') {
      expect(p.nextAction.question.length).toBeGreaterThan(0);
    }
  });
});

describe('METIS-307 QuickStart — four core scenario utterances', () => {
  const scenarios = [
    '细读《红楼梦》某回的叙事结构', // literary close reading
    '综述近五年数字劳工研究', // literature review
    '对这批农民工访谈做主题编码', // qualitative interview
    '用 CGSS 数据估计教育对收入的回归', // quantitative
  ];

  for (const intent of scenarios) {
    it(`creates a project for: "${intent.slice(0, 20)}…"`, () => {
      const p = createProjectFromIntent(intent, FIXED);
      expect(p.id).toBeDefined();
      expect(p.originalIntent).toBe(intent);
      expect(['clarify', 'plan']).toContain(p.nextAction.kind);
      // primary capability is one of the seven
      const sevenIds = [
        'research-design', 'source-research', 'literature-review',
        'qualitative-analysis', 'quantitative-analysis', 'argumentation-writing', 'verification-delivery',
      ];
      expect(sevenIds).toContain(p.routing.classification.primaryCapabilityId);
    });
  }
});
