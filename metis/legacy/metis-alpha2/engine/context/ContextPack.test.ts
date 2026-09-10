/**
 * METIS-205 — Context Pack generator tests.
 *
 * Verifies: hard budget cap, traceability (every evidence/decision id present), info
 * retention for normal projects, graceful truncation for over-long projects, and empty-state.
 */

import { describe, it, expect } from 'vitest';
import {
  buildContextPack,
  DEFAULT_CONTEXT_PACK_BUDGET_CHARS,
  MAX_CONTEXT_PACK_BUDGET_CHARS,
  type ProjectContextInput,
} from './ContextPack.js';
import { selectTools } from '../routing/CapabilityRouter.js';

function baseInput(overrides: Partial<ProjectContextInput> = {}): ProjectContextInput {
  return {
    projectId: 'proj-1',
    projectTitle: '清代科举与社会流动',
    researchQuestion: '科举功名对家族代际社会流动的因果效应有多大？',
    planStatus: 'running',
    recentDecisions: [
      { id: 'dec-1', text: '采用族谱数据而非地方志' },
      { id: 'dec-2', text: '方法定为 DID 而非简单回归' },
    ],
    evidence: [
      { id: 'ev-1', sourceId: 'src-A', snippet: '某族谱显示三代内出进士一人' },
      { id: 'ev-2', sourceId: 'src-B', snippet: '地方志记录该县科举配额' },
    ],
    currentTask: '估计 DID 模型并输出事件研究图',
    ...overrides,
  };
}

describe('METIS-205 ContextPack — budget', () => {
  it('produces a pack under the default budget for a normal project', () => {
    const pack = buildContextPack(baseInput());
    expect(pack.finalChars).toBeLessThanOrEqual(DEFAULT_CONTEXT_PACK_BUDGET_CHARS);
    expect(pack.truncated).toBe(false);
  });

  it('respects a smaller custom budget', () => {
    // baseInput raw content is ~600 chars; use a budget smaller than that to force truncation.
    const big = buildContextPack(baseInput(), 100_000);
    const raw = big.rawChars;
    const budget = Math.floor(raw / 2); // well below raw => must truncate
    const pack = buildContextPack(baseInput(), budget);
    expect(pack.finalChars).toBeLessThanOrEqual(budget);
    expect(pack.truncated).toBe(true);
    expect(pack.text).toMatch(/已达硬上限/);
  });

  it('clamps budget to the absolute maximum', () => {
    const pack = buildContextPack(baseInput(), 1_000_000);
    // internal clamp means finalChars is still bounded by content, not inflated
    expect(pack.finalChars).toBeLessThanOrEqual(MAX_CONTEXT_PACK_BUDGET_CHARS + 200);
  });

  it('over-long evidence is truncated but still bounded', () => {
    const huge = baseInput({
      evidence: Array.from({ length: 500 }, (_, i) => ({
        id: `ev-${i}`,
        sourceId: `src-${i}`,
        snippet: '证据片段'.repeat(40),
      })),
    });
    const pack = buildContextPack(huge, 2000);
    expect(pack.finalChars).toBeLessThanOrEqual(2000);
    expect(pack.truncated).toBe(true);
  });
});

describe('METIS-205 ContextPack — traceability', () => {
  it('records every evidence id and source id in references', () => {
    const pack = buildContextPack(baseInput());
    expect(pack.references.evidence).toContain('ev-1');
    expect(pack.references.evidence).toContain('ev-2');
    expect(pack.references.sources).toContain('src-A');
    expect(pack.references.sources).toContain('src-B');
  });

  it('records decision ids in references', () => {
    const pack = buildContextPack(baseInput());
    expect(pack.references.decisions).toContain('dec-1');
    expect(pack.references.decisions).toContain('dec-2');
  });

  it('text mentions the ids (so the model can cite them back)', () => {
    const pack = buildContextPack(baseInput());
    expect(pack.text).toContain('ev-1');
    expect(pack.text).toContain('dec-1');
    expect(pack.text).toContain('src-A');
  });
});

describe('METIS-205 ContextPack — info retention', () => {
  it('retains research question, current task, and tool list', () => {
    const tools = selectTools({
      researchType: 'causal_inference',
      stage: 'quantitative_analysis',
      primaryCapabilityId: 'quantitative-analysis',
      confidence: 0.9,
      matchedSignals: [],
    });
    const pack = buildContextPack({ ...baseInput(), tools });
    expect(pack.text).toContain('科举');
    expect(pack.text).toContain('DID');
    expect(pack.text).toContain('允许工具');
    // some tool names appear
    expect(pack.text.toLowerCase()).toMatch(/run_|search_|read_/);
  });

  it('includes the primary capability name in the tools block', () => {
    const tools = selectTools({
      researchType: 'causal_inference',
      stage: 'quantitative_analysis',
      primaryCapabilityId: 'quantitative-analysis',
      confidence: 0.9,
      matchedSignals: [],
    });
    const pack = buildContextPack({ ...baseInput(), tools });
    expect(pack.text).toContain('主能力');
  });
});

describe('METIS-205 ContextPack — empty / minimal state', () => {
  it('handles a brand-new project with no evidence/decisions/task gracefully', () => {
    const pack = buildContextPack({
      projectId: 'p-new',
      projectTitle: '新项目',
    });
    expect(pack.text).toContain('待澄清');
    expect(pack.text).toContain('暂无登记证据');
    expect(pack.text).toContain('暂无最近决策');
    expect(pack.text).toContain('未指定');
    expect(pack.references.evidence).toHaveLength(0);
  });

  it('always includes the project id and title', () => {
    const pack = buildContextPack({ projectId: 'p-x', projectTitle: 'X' });
    expect(pack.projectId).toBe('p-x');
    expect(pack.text).toContain('X');
  });
});
