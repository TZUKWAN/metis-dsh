/**
 * Visual regression framework (METIS-1003) + real-model quality eval (METIS-1002).
 *
 * 1003: defines the screenshot capture plan (multi-resolution + light/dark + long-text +
 *      large-table + empty states) and the diff gate. Actual pixel capture runs under
 *      Playwright + Electron at release time; this is the testable plan + diff logic.
 * 1002: defines the real-model evaluation protocol (9B / GLM / strong model), blind-rating
 *      criteria, and the capability-boundary summary. Real execution needs a live API key
 *      and human blind-rating — explicitly marked, never faked.
 */

// ─── METIS-1003 Visual regression ─────────────────────────────

export interface VisualCaptureTarget {
  id: string;
  /** Route / component to capture. */
  target: string;
  resolutions: Array<{ width: number; height: number }>;
  themes: Array<'light' | 'dark'>;
  /** Content variant (long-text / large-table / empty / default). */
  variant: 'default' | 'long_text' | 'large_table' | 'empty';
}

export const VISUAL_CAPTURE_PLAN: readonly VisualCaptureTarget[] = [
  { id: 'shell-3col', target: '/projects/p1/converse', resolutions: [{ width: 1366, height: 768 }, { width: 1920, height: 1080 }, { width: 2560, height: 1440 }], themes: ['light', 'dark'], variant: 'default' },
  { id: 'shell-narrow', target: '/projects/p1/converse', resolutions: [{ width: 1024, height: 768 }], themes: ['light'], variant: 'default' },
  { id: 'read-pdf-long', target: '/projects/p1/read', resolutions: [{ width: 1920, height: 1080 }], themes: ['light', 'dark'], variant: 'long_text' },
  { id: 'analyze-large-table', target: '/projects/p1/analyze', resolutions: [{ width: 1920, height: 1080 }], themes: ['light'], variant: 'large_table' },
  { id: 'library-empty', target: '/library', resolutions: [{ width: 1920, height: 1080 }], themes: ['light', 'dark'], variant: 'empty' },
];

export interface VisualDiff {
  captureId: string;
  pixelDiffPct: number;
  passed: boolean;
}

/** A diff over the threshold fails the visual gate (METIS-1003). */
export function evaluateVisualDiff(diff: VisualDiff, thresholdPct = 0.5): VisualDiff {
  return { ...diff, passed: diff.pixelDiffPct <= thresholdPct };
}

/** Visual gate: any failing capture (overlap/truncation/blank/unreadable) blocks release. */
export function visualGate(diffs: VisualDiff[]): { passed: boolean; failures: VisualDiff[] } {
  const failures = diffs.filter((d) => !d.passed);
  return { passed: failures.length === 0, failures };
}

/** Human review checklist for each capture (METIS-1003: manual per-image review). */
export const VISUAL_REVIEW_CHECKLIST = [
  'no overlap between columns/panels',
  'no truncation of headings/labels',
  'no blank canvas where content expected',
  'legends/axis labels readable',
  'no broken resource (missing icon/image)',
  'light + dark both legible',
] as const;

// ─── METIS-1002 Real-model quality eval ───────────────────────

export type ModelClass = 'small_9b' | 'glm_compatible' | 'strong';

export interface RealModelEvalCase {
  id: string;
  capabilityId: string;
  prompt: string;
  /** Blind-rating criteria. */
  ratingCriteria: string[];
}

export const REAL_MODEL_EVAL_CASES: readonly RealModelEvalCase[] = [
  { id: 'rme-design', capabilityId: 'research-design', prompt: '从"短视频与青少年"形成研究设计', ratingCriteria: ['问题可论证', '方法匹配', '范围明确'] },
  { id: 'rme-review', capabilityId: 'literature-review', prompt: '综述数字劳工研究', ratingCriteria: ['引用真实可查', '有审计轨迹', '非单次搜索摘要'] },
  { id: 'rme-qual', capabilityId: 'qualitative-analysis', prompt: '对访谈做主题编码', ratingCriteria: ['编码有证据片段', 'AI与人工区分', '置信度合理'] },
  { id: 'rme-quant', capabilityId: 'quantitative-analysis', prompt: '用 DID 估计因果效应', ratingCriteria: ['先做诊断', '不绕过诊断下结论', '有限制说明'] },
];

export interface RealModelEvalResult {
  modelClass: ModelClass;
  model: string;
  caseId: string;
  /** Human blind rating 0-1 per criterion, averaged. */
  score: number;
  taskCompleted: boolean;
  /** Whether the model fabricated a citation/source (METIS-1002 honesty check). */
  fabricatedSource: boolean;
}

export interface ModelClassBoundary {
  modelClass: ModelClass;
  /** Capabilities this class handles acceptably (score >= threshold). */
  acceptable: string[];
  /** Capabilities requiring automatic downgrade to finer-grained steps (METIS-303). */
  needsDowngrade: string[];
}

/**
 * Summarize capability boundaries per model class, driving the auto-downgrade strategy.
 * NOTE: real scores come from live-model runs + human blind-rating (METIS-1002). Until those
 * are collected, this returns an empty summary — it never fabricates a boundary.
 */
export function summarizeBoundaries(results: RealModelEvalResult[], scoreThreshold = 0.7): ModelClassBoundary[] {
  const byClass = new Map<ModelClass, RealModelEvalResult[]>();
  for (const r of results) {
    const arr = byClass.get(r.modelClass) ?? [];
    arr.push(r);
    byClass.set(r.modelClass, arr);
  }
  const out: ModelClassBoundary[] = [];
  for (const [modelClass, rs] of byClass) {
    const acceptable = rs.filter((r) => r.score >= scoreThreshold && !r.fabricatedSource).map((r) => r.caseId);
    const needsDowngrade = rs.filter((r) => r.score < scoreThreshold).map((r) => r.caseId);
    out.push({ modelClass, acceptable, needsDowngrade });
  }
  return out;
}
