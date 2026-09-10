/**
 * ComputedFact — 计算事实溯源模型（T6 铁律）。
 *
 * 铁律：所有数字必须出自确定性代码，禁止模型笔算。统计引擎的每个产出
 * 都是一个 ComputedFact：数值 + 溯源（哪个引擎、哪版数据指纹、哪次运行）。
 * 写作与 QA 引用数字时只引用 ComputedFact，不接受裸数字。
 */
import { createHash } from 'node:crypto';

export interface ComputedFactSource {
  kind: 'statistics' | 'datacheck' | 'cleaning';
  /** 引擎标识与版本（如 "metis-stats/1"）。 */
  engine: string;
  /** 输入数据的指纹（内容 hash）：换数据即失效。 */
  dataFingerprint: string;
  /** 随机种子（统计计算必须固定）。 */
  seed: number;
  /** 关联的运行/作业 id。 */
  runId: string | null;
}

export interface ComputedFact {
  /** 机器可读标识，写作引用时使用。 */
  id: string;
  /** 数值标签（如 "样本量"、"女性占比"、"回归系数(教育年限)"）。 */
  label: string;
  value: number;
  /** 展示单位（%、个、系数等），仅用于呈现。 */
  unit: string;
  /** 数字在文本中的规范呈现（占比 58.0 → "58%"）。 */
  formatted: string;
  source: ComputedFactSource;
  computedAt: number;
}

/** 数据指纹：对任意文本（CSV/JSON 数据）生成稳定内容 hash。 */
export function fingerprintData(content: string): string {
  return createHash('sha256').update(content, 'utf8').digest('hex').slice(0, 16);
}

export function makeComputedFact(input: {
  label: string;
  value: number;
  unit: string;
  source: ComputedFactSource;
}): ComputedFact {
  const rounded = Number.isFinite(input.value) ? Math.round(input.value * 1e6) / 1e6 : input.value;
  const formatted = formatFactValue(rounded, input.unit);
  return {
    id: `fact-${input.source.engine}-${createHash('sha1')
      .update(`${input.label}|${rounded}|${input.source.dataFingerprint}`)
      .digest('hex')
      .slice(0, 10)}`,
    label: input.label,
    value: rounded,
    unit: input.unit,
    formatted,
    source: input.source,
    computedAt: Date.now(),
  };
}

export function formatFactValue(value: number, unit: string): string {
  if (unit === '%') {
    return `${trimZeros(value.toFixed(1))}%`;
  }
  if (unit === 'p') {
    return value < 0.001 ? 'p<0.001' : `p=${trimZeros(value.toFixed(3))}`;
  }
  return trimZeros(String(rounded(value)));
}

function rounded(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}

function trimZeros(text: string): string {
  return text.replace(/\.?0+$/u, (match) => (match.includes('.') && match.startsWith('.') ? '' : match));
}
