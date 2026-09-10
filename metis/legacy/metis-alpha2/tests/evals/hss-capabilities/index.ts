/**
 * HSS Capability Evaluation Suite (METIS-210).
 *
 * Real, no-copyright-risk evaluation cases for the seven native capabilities. Each case
 * specifies: the capability under test, the input prompt, the expected STRUCTURE of the
 * output (not exact text — so it works across models), traceability assertions (does the
 * output cite registered sources?), and failure-handling assertions (does it refuse to
 * fabricate when evidence is missing?).
 *
 * Two execution modes (per task list):
 *   - structural: run against FakeProvider / scripted responses — checks the pipeline
 *     produces well-shaped artifacts. Deterministic, offline.
 *   - model-quality: run against a real model — records quality separately, not asserted
 *     in CI (needs a real key + human-blind-rating in METIS-1002).
 *
 * The cases here are authored from scratch (public-domain research-methods framing); no
 * third-party prompts or copyrighted text are copied (METIS-201/1006 compliance).
 */

import type { ResearchStage } from '../../../engine/capabilities/types.js';

export interface HSSCase {
  id: string;
  capabilityId: string;
  stage: ResearchStage;
  /** The research intent to evaluate. */
  prompt: string;
  /** Expected structural elements in the output (each must appear). */
  expectedStructure: string[];
  /** Traceability: the output must reference some source/evidence id when expected. */
  expectsTraceability: boolean;
  /** Failure-handling: when evidence is missing, the output must NOT fabricate. */
  expectsNoFabrication?: { whenMissing: string };
  /** Forbidden patterns (e.g. invented DOIs, unsupported causal claims). */
  forbiddenPatterns?: string[];
}

export const HSS_CASES: readonly HSSCase[] = [
  // ── research-design ──
  {
    id: 'rd-1',
    capabilityId: 'research-design',
    stage: 'design',
    prompt: '我想研究短视频对青少年学业表现的影响，帮我形成一个研究设计。',
    expectedStructure: ['研究问题', '理论视角', '方法', '资料范围', '交付物'],
    expectsTraceability: false,
  },
  // ── source-research ──
  {
    id: 'sr-1',
    capabilityId: 'source-research',
    stage: 'source_research',
    prompt: '检索关于 deliberative democracy 的英文文献。',
    expectedStructure:['资料列表'],
    expectsTraceability: true,
    expectsNoFabrication: { whenMissing: '若检索失败，必须明确说明失败，不得编造文献' },
    forbiddenPatterns: ['10.9999/fake', '虚构 DOI'],
  },
  // ── literature-review ──
  {
    id: 'lr-1',
    capabilityId: 'literature-review',
    stage: 'literature_review',
    prompt: '对近五年数字劳工研究做一个综述。',
    expectedStructure: ['检索式', '纳入标准', '综合', '引用'],
    expectsTraceability: true,
    expectsNoFabrication: { whenMissing: '综述不得包含无法定位的引用' },
  },
  // ── qualitative-analysis ──
  {
    id: 'qa-1',
    capabilityId: 'qualitative-analysis',
    stage: 'qualitative_analysis',
    prompt: '对这段访谈做主题编码：受访者谈到工作强度、家庭冲突、身体疲劳。',
    expectedStructure: ['编码', '证据片段', '置信度'],
    expectsTraceability: true,
  },
  // ── quantitative-analysis ──
  {
    id: 'qx-1',
    capabilityId: 'quantitative-analysis',
    stage: 'quantitative_analysis',
    prompt: '用这份合成数据估计 DID 模型。',
    expectedStructure: ['诊断', '代码', '结果', '限制'],
    expectsTraceability: false,
    forbiddenPatterns: ['未做诊断即下因果结论', '忽略识别假设'],
  },
  // ── argumentation-writing ──
  {
    id: 'aw-1',
    capabilityId: 'argumentation-writing',
    stage: 'argumentation_writing',
    prompt: '基于这些 claim 写一段论证。',
    expectedStructure: ['论断', '引用', '证据'],
    expectsTraceability: true,
    expectsNoFabrication: { whenMissing: '不得出现无法定位的引文' },
  },
  // ── verification-delivery ──
  {
    id: 'vd-1',
    capabilityId: 'verification-delivery',
    stage: 'verification_delivery',
    prompt: '核验这段文稿的引用和数据一致性。',
    expectedStructure: ['错误', '警告', '建议', '无法验证'],
    expectsTraceability: true,
  },
];

// ─── Structural runner (offline, FakeProvider-friendly) ───────

export interface CaseResult {
  caseId: string;
  passed: boolean;
  structureHits: number;
  structureMisses: string[];
  traceabilityOk: boolean;
  fabricationCheck?: 'pass' | 'fail';
  forbiddenHits: string[];
}

/**
 * Evaluate a single output blob against a case's structural expectations. This is the
 * structural-mode checker (deterministic). Real model quality is recorded separately and
 * NOT asserted here (METIS-1002 blind rating).
 */
export function evaluateCase(caseDef: HSSCase, output: string): CaseResult {
  const lower = output.toLowerCase();
  const structureMisses: string[] = [];
  let structureHits = 0;
  for (const el of caseDef.expectedStructure) {
    if (output.includes(el) || lower.includes(el.toLowerCase())) {
      structureHits++;
    } else {
      structureMisses.push(el);
    }
  }

  // Traceability: if expected, the output should reference some id-like token.
  let traceabilityOk = true;
  if (caseDef.expectsTraceability) {
    traceabilityOk = /\[?(证据|来源|src|ev|doi|引用)\b/i.test(output);
  }

  // Forbidden patterns
  const forbiddenHits: string[] = [];
  for (const pat of caseDef.forbiddenPatterns ?? []) {
    if (output.includes(pat) || lower.includes(pat.toLowerCase())) forbiddenHits.push(pat);
  }

  // Fabrication check: if expectsNoFabrication and the prompt signals missing evidence,
  // the output must not claim success on fabricated content. Heuristic: if output contains
  // a forbidden fake marker, it's a fail.
  let fabricationCheck: 'pass' | 'fail' | undefined;
  if (caseDef.expectsNoFabrication) {
    fabricationCheck = forbiddenHits.length === 0 ? 'pass' : 'fail';
  }

  const passed = structureMisses.length === 0 && traceabilityOk && forbiddenHits.length === 0 && fabricationCheck !== 'fail';

  return { caseId: caseDef.id, passed, structureHits, structureMisses, traceabilityOk, fabricationCheck, forbiddenHits };
}

export function evaluateAll(outputs: Record<string, string>): { results: CaseResult[]; summary: { total: number; passed: number } } {
  const results = HSS_CASES.map((c) => evaluateCase(c, outputs[c.id] ?? ''));
  const passed = results.filter((r) => r.passed).length;
  return { results, summary: { total: results.length, passed } };
}
