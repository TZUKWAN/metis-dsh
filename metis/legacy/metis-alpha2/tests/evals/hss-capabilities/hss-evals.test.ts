/**
 * METIS-210 — HSS capability eval suite tests.
 *
 * Verifies the suite covers all seven capabilities, each case has structural + traceability
 * + failure-handling expectations, and the evaluator correctly scores good vs bad outputs
 * (including fabrication detection and forbidden-pattern hits).
 */

import { describe, it, expect } from 'vitest';
import { HSS_CASES, evaluateCase, evaluateAll } from './index.js';
import { SEVEN_CAPABILITY_IDS } from '../../../engine/capabilities/packs/index.js';

describe('METIS-210 HSS eval suite — coverage', () => {
  it('has at least one case per capability', () => {
    for (const capId of SEVEN_CAPABILITY_IDS) {
      const cases = HSS_CASES.filter((c) => c.capabilityId === capId);
      expect(cases.length, `${capId} needs ≥1 case`).toBeGreaterThanOrEqual(1);
    }
  });

  it('every case has expected structure, traceability decision, and a prompt', () => {
    for (const c of HSS_CASES) {
      expect(c.prompt.length).toBeGreaterThan(0);
      expect(c.expectedStructure.length).toBeGreaterThan(0);
      expect(typeof c.expectsTraceability).toBe('boolean');
    }
  });
});

describe('METIS-210 HSS eval suite — evaluator scoring', () => {
  it('passes a well-structured output that meets all expectations', () => {
    const c = HSS_CASES.find((x) => x.id === 'rd-1')!;
    const good = '研究问题：短视频时长与学业表现\n理论视角：注意力经济\n方法：问卷+访谈\n资料范围：中学生\n交付物：研究报告';
    const r = evaluateCase(c, good);
    expect(r.passed).toBe(true);
    expect(r.structureMisses).toHaveLength(0);
  });

  it('fails an output missing required structural elements', () => {
    const c = HSS_CASES.find((x) => x.id === 'rd-1')!;
    const bad = '这是一个研究'; // missing most elements
    const r = evaluateCase(c, bad);
    expect(r.passed).toBe(false);
    expect(r.structureMisses.length).toBeGreaterThan(0);
  });

  it('flags forbidden fabrication patterns (fake DOI)', () => {
    const c = HSS_CASES.find((x) => x.id === 'sr-1')!;
    const fabricated = '资料列表：1. 论文A [10.9999/fake] 2. 论文B';
    const r = evaluateCase(c, fabricated);
    expect(r.forbiddenHits.length).toBeGreaterThan(0);
    expect(r.fabricationCheck).toBe('fail');
    expect(r.passed).toBe(false);
  });

  it('detects missing traceability when expected', () => {
    const c = HSS_CASES.find((x) => x.id === 'qa-1')!;
    // A truly traceless output (no 证据/来源/src/ev/doi/引用 token) must fail traceability.
    const r = evaluateCase(c, '编码：A\n片段\n置信度：中');
    expect(r.traceabilityOk).toBe(false);
  });
});

describe('METIS-210 HSS eval suite — evaluateAll summary', () => {
  it('returns a total + passed count covering all cases', () => {
    const outputs: Record<string, string> = {};
    for (const c of HSS_CASES) outputs[c.id] = c.expectedStructure.join('\n');
    const { summary } = evaluateAll(outputs);
    expect(summary.total).toBe(HSS_CASES.length);
    expect(summary.passed).toBeGreaterThan(0);
  });
});
