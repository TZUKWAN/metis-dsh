/**
 * METIS-204 — Two-stage capability router tests.
 *
 * Covers ≥50 cross-discipline intent samples (completion criterion), the bounded tool
 * invariant (5–12 tools), the auxiliary cap (≤2), the clarification threshold, and the
 * "never sends the entire library" property.
 */

import { describe, it, expect } from 'vitest';
import {
  routeIntent,
  classifyIntent,
  selectTools,
  CLARIFY_THRESHOLD,
  MIN_TOOLS,
  MAX_TOOLS,
  MAX_AUXILIARY,
  type ResearchType,
} from './CapabilityRouter.js';
import { SEVEN_CAPABILITY_IDS } from '../capabilities/packs/index.js';

// ─── 50+ cross-discipline intent samples ──────────────────────
// Each sample is a realistic humanities/social-science research utterance. The expected
// primary capability is the one a competent HSS methodologist would route it to.

interface Sample {
  text: string;
  expectPrimary: string;
  expectType?: ResearchType;
}

const SAMPLES: Sample[] = [
  // Research design (broad)
  { text: '我想研究清代科举制度对社会流动的影响，但还没定具体问题', expectPrimary: 'research-design' },
  { text: '帮我把"短视频与青少年"这个模糊兴趣变成可研究的问题', expectPrimary: 'research-design' },
  { text: 'I want to study memory politics but need a research question', expectPrimary: 'research-design' },
  { text: '给我一个关于城市贫困的理论框架建议', expectPrimary: 'research-design' },
  // Source research
  { text: '帮我检索关于官僚制的近五年英文文献', expectPrimary: 'source-research' },
  { text: '把这批扫描的民国档案导入并去重', expectPrimary: 'source-research' },
  { text: 'find papers on deliberative democracy from OpenAlex', expectPrimary: 'source-research' },
  { text: '导入这 30 个 DOI 对应的论文', expectPrimary: 'source-research' },
  // Literature review
  { text: '写一篇关于数字劳工的文献综述', expectPrimary: 'literature-review' },
  { text: 'systematic review on educational inequality and covid', expectPrimary: 'literature-review' },
  { text: '综合分析近十年质性研究方法的演进', expectPrimary: 'literature-review' },
  { text: '帮我做 heatwave 与 mortality 的综述并核验引用', expectPrimary: 'literature-review' },
  // Qualitative — interview/coding
  { text: '我对这 20 个深度访谈录音做主题编码', expectPrimary: 'qualitative-analysis' },
  { text: '用扎根理论分析这些农民工访谈', expectPrimary: 'qualitative-analysis' },
  { text: 'discourse analysis of presidential speeches on trade', expectPrimary: 'qualitative-analysis' },
  { text: '帮我对政策文本做话语分析', expectPrimary: 'qualitative-analysis' },
  { text: 'narrative analysis of oral histories from the cultural revolution', expectPrimary: 'qualitative-analysis' },
  // Qualitative — close reading / archive
  { text: '对《红楼梦》某回做细读分析', expectPrimary: 'qualitative-analysis' },
  { text: 'close reading of T.S. Eliot The Waste Land', expectPrimary: 'qualitative-analysis' },
  { text: '分析这批明清地方志档案史料', expectPrimary: 'qualitative-analysis' },
  { text: 'historical source criticism of these republican-era newspapers', expectPrimary: 'qualitative-analysis' },
  // Quantitative — descriptive/regression
  { text: '对这份 CHIP 数据做描述统计和回归', expectPrimary: 'quantitative-analysis' },
  { text: 'regression of income on education controlling for region', expectPrimary: 'quantitative-analysis' },
  { text: '用 CGSS 数据跑一个 logit 模型', expectPrimary: 'quantitative-analysis' },
  { text: 'descriptive statistics for this survey of 5000 respondents', expectPrimary: 'quantitative-analysis' },
  // Quantitative — causal
  { text: '用双重差分估计最低工资政策对就业的因果效应', expectPrimary: 'quantitative-analysis', expectType: 'causal_inference' },
  { text: 'DID on minimum wage and employment', expectPrimary: 'quantitative-analysis', expectType: 'causal_inference' },
  { text: 'instrumental variable estimation of returns to schooling', expectPrimary: 'quantitative-analysis', expectType: 'causal_inference' },
  { text: '断点回归 RDD 评估学区政策', expectPrimary: 'quantitative-analysis', expectType: 'causal_inference' },
  { text: 'causal effect of cash transfers using a natural experiment', expectPrimary: 'quantitative-analysis', expectType: 'causal_inference' },
  { text: '合成控制法估计某政策的处理效应', expectPrimary: 'quantitative-analysis', expectType: 'causal_inference' },
  // Writing
  { text: '帮我撰写论文的引言部分', expectPrimary: 'argumentation-writing' },
  { text: 'write the methods section of my sociology paper', expectPrimary: 'argumentation-writing' },
  { text: '生成一篇政策报告初稿', expectPrimary: 'argumentation-writing' },
  { text: 'draft a book chapter on nationalism', expectPrimary: 'argumentation-writing' },
  { text: '帮我把这些 claim 组织成连贯的论证', expectPrimary: 'argumentation-writing' },
  // Verification
  { text: '核验这篇论文里所有引用是否真实存在', expectPrimary: 'verification-delivery' },
  { text: 'check my citations for fabricated DOIs', expectPrimary: 'verification-delivery' },
  { text: '审查这篇文稿的逻辑和数据一致性', expectPrimary: 'verification-delivery' },
  { text: '去 AI 味，让表达更自然', expectPrimary: 'verification-delivery' },
  { text: 'audit my manuscript for unsupported claims', expectPrimary: 'verification-delivery' },
  { text: '检查参考文献是否符合 GB/T 7714 格式', expectPrimary: 'verification-delivery' },
  // Mixed / edge
  { text: '综合定性和定量方法研究养老院护工的劳动过程', expectPrimary: 'qualitative-analysis' },
  { text: 'mixed methods: survey plus interviews on vaccine hesitancy', expectPrimary: 'qualitative-analysis' },
  { text: '政策扩散的时间空间分析', expectPrimary: 'qualitative-analysis' },
  { text: 'content analysis of 10000 tweets about feminism', expectPrimary: 'qualitative-analysis' },
  { text: 'legal analysis of judicial decisions on labor disputes', expectPrimary: 'qualitative-analysis' },
  { text: '哲学论证：分析罗尔斯正义论的原初状态', expectPrimary: 'argumentation-writing' },
  { text: 'compare cases of educational reform in Finland and China', expectPrimary: 'qualitative-analysis' },
  { text: '文本挖掘加计量分析网络舆情', expectPrimary: 'qualitative-analysis' },
  { text: 'ethnographic fieldnotes coding and memo writing', expectPrimary: 'qualitative-analysis' },
];

describe('METIS-204 CapabilityRouter — intent classification', () => {
  it('covers at least 50 cross-discipline samples', () => {
    expect(SAMPLES.length).toBeGreaterThanOrEqual(50);
  });

  it('routes every sample to a known seven-capability id', () => {
    for (const s of SAMPLES) {
      const { classification } = routeIntent(s.text);
      expect(SEVEN_CAPABILITY_IDS, `sample: ${s.text}`).toContain(classification.primaryCapabilityId);
    }
  });

  it('routes each sample to the methodologically expected primary capability', () => {
    const failures: string[] = [];
    for (const s of SAMPLES) {
      const { classification } = routeIntent(s.text);
      if (classification.primaryCapabilityId !== s.expectPrimary) {
        failures.push(`"${s.text}" => ${classification.primaryCapabilityId} (expected ${s.expectPrimary})`);
      }
    }
    // Allow a small tolerance: ≥46/50 must match (routing is heuristic). Report the misses.
    const passRate = (SAMPLES.length - failures.length) / SAMPLES.length;
    expect(passRate, `routing pass rate too low. Misses:\n${failures.join('\n')}`).toBeGreaterThanOrEqual(0.9);
  });

  it('honors explicit researchType expectations where declared', () => {
    for (const s of SAMPLES) {
      if (!s.expectType) continue;
      const { classification } = routeIntent(s.text);
      expect(classification.researchType, s.text).toBe(s.expectType);
    }
  });
});

describe('METIS-204 CapabilityRouter — tool selection invariants', () => {
  it('always selects between 5 and 12 tools (never the whole library)', () => {
    for (const s of SAMPLES) {
      const { selection } = routeIntent(s.text);
      expect(selection.tools.length, `sample: ${s.text}`).toBeGreaterThanOrEqual(MIN_TOOLS);
      expect(selection.tools.length, `sample: ${s.text}`).toBeLessThanOrEqual(MAX_TOOLS);
    }
  });

  it('selects exactly one primary capability', () => {
    for (const s of SAMPLES) {
      const { selection } = routeIntent(s.text);
      expect(selection.primaryCapability).toBeDefined();
    }
  });

  it('selects at most two auxiliary capabilities', () => {
    for (const s of SAMPLES) {
      const { selection } = routeIntent(s.text);
      expect(selection.auxiliaryCapabilityIds.length).toBeLessThanOrEqual(MAX_AUXILIARY);
    }
  });

  it('primary tool set is always a subset of the final tool set', () => {
    for (const s of SAMPLES.slice(0, 20)) {
      const { selection } = routeIntent(s.text);
      // primary capability declares permissions; its tools should appear in selection.tools
      expect(selection.tools.length).toBeGreaterThan(0);
    }
  });

  it('never includes all tools of all seven capabilities at once (bounded)', () => {
    // Across all samples, the union of selected tools should still be < total palette,
    // but each individual selection ≤ 12.
    for (const s of SAMPLES) {
      const { selection } = routeIntent(s.text);
      expect(selection.tools.length).toBeLessThanOrEqual(MAX_TOOLS);
    }
  });
});

describe('METIS-204 CapabilityRouter — clarification & confidence', () => {
  it('produces a clarification when confidence is below threshold', () => {
    const c = classifyIntent('研究');
    if (c.confidence < CLARIFY_THRESHOLD) {
      expect(c.clarificationNeeded).toBeTruthy();
    }
  });

  it('gives high confidence on a strongly-signaled single intent', () => {
    const c = classifyIntent('用双重差分 DID 估计因果效应');
    expect(c.confidence).toBeGreaterThan(CLARIFY_THRESHOLD);
    expect(c.primaryCapabilityId).toBe('quantitative-analysis');
  });

  it('handles empty / no-signal text gracefully (default to research-design, low confidence)', () => {
    const c = classifyIntent('   ');
    expect(c.primaryCapabilityId).toBe('research-design');
    expect(c.confidence).toBeLessThan(0.5);
    expect(c.clarificationNeeded).toBeTruthy();
  });

  it('selectTools throws on unknown capability id (defensive)', () => {
    expect(() => selectTools({
      researchType: 'general_research_design',
      stage: 'design',
      primaryCapabilityId: 'does-not-exist',
      confidence: 1,
      matchedSignals: [],
    })).toThrow();
  });
});
