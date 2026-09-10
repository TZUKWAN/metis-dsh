/**
 * NumberConsistencyChecker — 数字一致性核查（T7，DataTruth）。
 *
 * CitationTruth 防"编文献"；本模块防"编数据"：抽取成果文本中的数字声明，
 * 逐一回查已注册的计算事实（ComputedFact），输出核对表：
 *  - matched：与某个计算事实一致；
 *  - mismatch：文本数字与最接近的事实冲突（高优先问题）；
 *  - unverifiable：没有对应计算事实支撑（中优先，提示补计算依据）。
 * 全部确定性规则，零模型调用。
 */
import type { ComputedFact } from './ComputedFact.js';

export type NumberCheckStatus = 'matched' | 'mismatch' | 'unverifiable';

export interface NumberDeclaration {
  /** 原文数字串（"58%"、"0.35"、"N=1,200"）。 */
  raw: string;
  /** 解析出的数值。 */
  value: number;
  /** 上下文窗口（前后各 ~40 字符），用于呈现与判断类型。 */
  context: string;
  status: NumberCheckStatus;
  /** matched/mismatch 时对应的计算事实。 */
  matchedFactId: string | null;
}

export interface ConsistencyReport {
  declarations: NumberDeclaration[];
  counts: { matched: number; mismatch: number; unverifiable: number };
  ok: boolean;
}

/** 需要核查的数字形态：百分比、N=、p 值、系数、普通整数（≥10 才查，避免年份/编号噪音）。 */
const DECLARATION_PATTERN = /(\d+(?:\.\d+)?%|[Nn]\s*=\s*[\d,]+|p\s*[<>=]\s*0?\.\d+|\d+\.\d{2,}|(?<![年.\d])\d{3,}(?!\d*年))/gu;

/** 声明本身或紧邻字符明显不是数据声明（年份、图表号、章节号）。 */
const CONTEXT_NOISE = /(?:19|20)\d{2}\s*年|图\s*\d|表\s*\d|第\s*\d+\s*[章节页]/u;

export function extractNumberDeclarations(text: string): Array<{ raw: string; value: number; context: string }> {
  const results: Array<{ raw: string; value: number; context: string }> = [];
  for (const match of text.matchAll(DECLARATION_PATTERN)) {
    const raw = match[0]!;
    // 噪音判断只看声明本身及紧邻字符（宽窗口会把"2023 年调查（N=1,200）"
    // 里的有效声明一并误杀）。
    const tight = text.slice(Math.max(0, match.index - 3), Math.min(text.length, match.index + raw.length + 3));
    if (CONTEXT_NOISE.test(tight)) continue;
    const start = Math.max(0, match.index - 40);
    const context = text.slice(start, Math.min(text.length, match.index + raw.length + 40));
    const value = parseDeclarationValue(raw);
    if (value === null || Number.isNaN(value)) continue;
    if (results.some((item) => item.raw === raw && item.context === context)) continue;
    results.push({ raw, value, context });
  }
  return results;
}

function parseDeclarationValue(raw: string): number | null {
  if (raw.endsWith('%')) {
    const num = Number(raw.slice(0, -1));
    return Number.isFinite(num) ? num : null;
  }
  if (/^[Nn]\s*=/.test(raw)) {
    const num = Number(raw.replace(/^[Nn]\s*=\s*/u, '').replace(/,/g, ''));
    return Number.isFinite(num) ? num : null;
  }
  if (/^p\s*[<>=]/i.test(raw)) {
    const num = Number(raw.replace(/^p\s*[<>=]\s*/iu, ''));
    return Number.isFinite(num) ? num : null;
  }
  const num = Number(raw.replace(/,/g, ''));
  return Number.isFinite(num) ? num : null;
}

/** 数值比较容差：相对 0.5% 或绝对 0.001。 */
function valuesClose(a: number, b: number): boolean {
  if (a === b) return true;
  const tolerance = Math.max(Math.abs(b) * 0.005, 0.001);
  return Math.abs(a - b) <= tolerance;
}

export function checkNumberConsistency(text: string, facts: ComputedFact[]): ConsistencyReport {
  const declarations: NumberDeclaration[] = extractNumberDeclarations(text).map((item) => {
    const exact = facts.find((fact) => valuesClose(item.value, fact.value));
    if (exact) {
      return { ...item, status: 'matched' as const, matchedFactId: exact.id };
    }
    // mismatch 判定：数值类型相近（同为百分比/同为小数）且非常接近但超出容差。
    const near = facts
      .filter((fact) => sameMagnitudeKind(item.raw, fact))
      .sort((a, b) => Math.abs(item.value - a.value) - Math.abs(item.value - b.value))[0];
    if (near && Math.abs(item.value - near.value) <= Math.max(Math.abs(near.value) * 0.2, Math.abs(near.value) < 1 ? 0.05 : 2)) {
      return { ...item, status: 'mismatch' as const, matchedFactId: near.id };
    }
    return { ...item, status: 'unverifiable' as const, matchedFactId: null };
  });
  const counts = {
    matched: declarations.filter((d) => d.status === 'matched').length,
    mismatch: declarations.filter((d) => d.status === 'mismatch').length,
    unverifiable: declarations.filter((d) => d.status === 'unverifiable').length,
  };
  return { declarations, counts, ok: counts.mismatch === 0 };
}

function sameMagnitudeKind(raw: string, fact: ComputedFact): boolean {
  const isPercent = raw.includes('%');
  if (isPercent) return fact.unit === '%';
  if (/^p/i.test(raw)) return fact.unit === 'p';
  if (/^[Nn]=/i.test(raw)) return fact.label.includes('样本') || fact.label.toLowerCase().includes('sample');
  return fact.unit !== '%' && fact.unit !== 'p';
}
