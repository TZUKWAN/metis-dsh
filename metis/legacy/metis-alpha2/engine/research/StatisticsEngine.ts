/**
 * StatisticsEngine — 本地确定性统计引擎（T21，遵守 T6 铁律）。
 *
 * 所有数字由确定性代码计算，禁止模型笔算：
 *   - describe：均值/标准差/分位数（Welford 单遍算法）
 *   - crosstab：交叉表 + 行百分比 + 卡方独立性检验 + Cramér's V
 *   - ols：多元线性回归（正规方程 + 高斯消元），系数/标准误/t/p/R²
 *
 * 双通道复核（T6.2）：OLS 用两条独立实现（正规方程 vs 中心化最小二乘）
 * 重算并比对；描述统计用两遍不同算法交叉验证。内置已知解校验
 * （T6.3）：runBuiltInChecks 用 Anscombe I 组等已知解数据自检。
 */

import { makeComputedFact, type ComputedFact, type ComputedFactSource } from './ComputedFact.js';

const SOURCE: ComputedFactSource = {
  kind: 'statistics',
  engine: 'metis-stats/1',
  dataFingerprint: 'inline',
  seed: 42,
  runId: null,
};

export interface DescribeResult {
  n: number;
  mean: number;
  sd: number;
  min: number;
  q1: number;
  median: number;
  q3: number;
  max: number;
}

export function describe(values: number[]): DescribeResult {
  const clean = values.filter((value) => Number.isFinite(value));
  const n = clean.length;
  if (n === 0) throw new Error('describe: no finite values');
  // 通道一：Welford 单遍。
  let mean = 0;
  let m2 = 0;
  for (let index = 0; index < n; index += 1) {
    const delta = clean[index]! - mean;
    mean += delta / (index + 1);
    m2 += delta * (clean[index]! - mean);
  }
  const sd = n > 1 ? Math.sqrt(m2 / (n - 1)) : 0;
  // 通道二：直接求和复核。
  const meanCheck = clean.reduce((sum, value) => sum + value, 0) / n;
  if (Math.abs(mean - meanCheck) > Math.max(1e-9, Math.abs(mean) * 1e-12)) {
    throw new Error('describe: dual-channel mean mismatch');
  }
  const sorted = [...clean].sort((a, b) => a - b);
  const quantile = (p: number): number => {
    const at = (n - 1) * p;
    const low = Math.floor(at);
    const high = Math.ceil(at);
    if (low === high) return sorted[low]!;
    return sorted[low]! + (sorted[high]! - sorted[low]!) * (at - low);
  };
  return {
    n,
    mean: round(mean),
    sd: round(sd),
    min: sorted[0]!,
    q1: round(quantile(0.25)),
    median: round(quantile(0.5)),
    q3: round(quantile(0.75)),
    max: sorted[n - 1]!,
  };
}

export interface CrosstabCell {
  value: number;
  rowPercent: number;
}

export interface CrosstabResult {
  rowLabels: string[];
  colLabels: string[];
  cells: CrosstabCell[][];
  chiSquare: number;
  degreesOfFreedom: number;
  cramersV: number;
  minExpected: number;
}

export function crosstab(rows: Array<Record<string, unknown>>, varA: string, varB: string): CrosstabResult {
  const rowMap = new Map<string, Map<string, number>>();
  for (const row of rows) {
    const a = String(row[varA] ?? '');
    const b = String(row[varB] ?? '');
    if (!a || !b) continue;
    const inner = rowMap.get(a) ?? new Map<string, number>();
    inner.set(b, (inner.get(b) ?? 0) + 1);
    rowMap.set(a, inner);
  }
  const rowLabels = [...rowMap.keys()].sort();
  const colLabels = [...new Set([...rowMap.values()].flatMap((inner) => [...inner.keys()]))].sort();
  const grand = rows.length;
  if (rowLabels.length === 0 || colLabels.length === 0 || grand === 0) throw new Error('crosstab: empty table');

  const rowTotals = rowLabels.map((label) => [...rowMap.get(label)!.values()].reduce((sum, value) => sum + value, 0));
  const colTotals = colLabels.map((label) => rowLabels.reduce((sum, rowLabel) => sum + (rowMap.get(rowLabel)!.get(label) ?? 0), 0));

  let chiSquare = 0;
  let minExpected = Number.POSITIVE_INFINITY;
  const cells: CrosstabCell[][] = rowLabels.map((rowLabel, rowIndex) =>
    colLabels.map((colLabel, colIndex) => {
      const observed = rowMap.get(rowLabel)!.get(colLabel) ?? 0;
      const expected = (rowTotals[rowIndex]! * colTotals[colIndex]!) / grand;
      chiSquare += (observed - expected) ** 2 / expected;
      minExpected = Math.min(minExpected, expected);
      return {
        value: observed,
        rowPercent: round((observed / rowTotals[rowIndex]!) * 100),
      };
    }),
  );
  const degreesOfFreedom = (rowLabels.length - 1) * (colLabels.length - 1);
  const cramersV = round(Math.sqrt(chiSquare / (grand * Math.min(rowLabels.length - 1, colLabels.length - 1))));
  return { rowLabels, colLabels, cells, chiSquare: round(chiSquare), degreesOfFreedom, cramersV, minExpected: round(minExpected) };
}

export interface OlsResult {
  n: number;
  coefficients: number[];
  standardErrors: number[];
  tValues: number[];
  pValues: number[];
  rSquared: number;
  adjRSquared: number;
  /** 双通道复核：中心化实现重算的系数（应与主通道一致）。 */
  verificationCoefficients: number[];
  verified: boolean;
}

/** 正态分布 CDF（Abramowitz-Stegun 近似，用于 p 值）。 */
function normalCdf(z: number): number {
  const t = 1 / (1 + 0.2316419 * Math.abs(z));
  const poly = t * (0.319381530 + t * (-0.356563782 + t * (1.781477937 + t * (-1.821255978 + t * 1.330274429))));
  const cdf = 1 - (Math.exp(-0.5 * z * z) / Math.sqrt(2 * Math.PI)) * poly;
  return z >= 0 ? cdf : 1 - cdf;
}

/** 高斯消元解线性方程组（带部分主元）。 */
function solveLinearSystem(matrix: number[][], vector: number[]): number[] {
  const size = vector.length;
  const augmented = matrix.map((row, index) => [...row, vector[index]!]);
  for (let column = 0; column < size; column += 1) {
    let pivotRow = column;
    for (let row = column + 1; row < size; row += 1) {
      if (Math.abs(augmented[row]![column]!) > Math.abs(augmented[pivotRow]![column]!)) pivotRow = row;
    }
    if (Math.abs(augmented[pivotRow]![column]!) < 1e-12) throw new Error('ols: singular design matrix');
    [augmented[column], augmented[pivotRow]] = [augmented[pivotRow]!, augmented[column]!];
    const pivot = augmented[column]![column]!;
    for (let row = 0; row < size; row += 1) {
      if (row === column) continue;
      const factor = augmented[row]![column]! / pivot;
      for (let k = column; k <= size; k += 1) {
        augmented[row]![k]! -= factor * augmented[column]![k]!;
      }
    }
  }
  return Array.from({ length: size }, (_, index) => augmented[index]![size]! / augmented[index]![index]!);
}

export function ols(X: number[][], y: number[]): OlsResult {
  const n = y.length;
  if (n !== X.length || n === 0) throw new Error('ols: X and y length mismatch');
  const k = X[0]!.length;
  const paramCount = k + 1; // 含截距
  if (n <= paramCount) throw new Error(`ols: insufficient observations (n=${n}, parameters=${paramCount})`);

  // 主通道：设计矩阵加截距，正规方程 (X'X)b = X'y。
  const designMatrix = X.map((row) => [1, ...row]);

  const xtx: number[][] = Array.from({ length: paramCount }, () => Array.from({ length: paramCount }, () => 0));
  const xty: number[] = Array.from({ length: paramCount }, () => 0);
  for (let index = 0; index < n; index += 1) {
    const row = designMatrix[index]!;
    for (let i = 0; i < paramCount; i += 1) {
      xty[i]! += row[i]! * y[index]!;
      for (let j = 0; j < paramCount; j += 1) {
        xtx[i]![j]! += row[i]! * row[j]!;
      }
    }
  }
  const coefficients = solveLinearSystem(xtx, xty);

  // 残差、R²、标准误。
  let ssResidual = 0;
  let ssTotal = 0;
  const meanY = y.reduce((sum, value) => sum + value, 0) / n;
  const residuals: number[] = [];
  for (let index = 0; index < n; index += 1) {
    const row = designMatrix[index]!;
    const fitted = row.reduce((sum, value, i) => sum + value * coefficients[i]!, 0);
    const residual = y[index]! - fitted;
    residuals.push(residual);
    ssResidual += residual * residual;
    ssTotal += (y[index]! - meanY) ** 2;
  }
  const rSquared = ssTotal > 0 ? 1 - ssResidual / ssTotal : 0;
  const df = n - paramCount;
  const sigma2 = ssResidual / df;
  // (X'X)^-1 对角线 → 系数方差。用单位矩阵逐列求解。
  const standardErrors: number[] = [];
  for (let i = 0; i < paramCount; i += 1) {
    const unit = Array.from({ length: paramCount }, (_, j) => (j === i ? 1 : 0));
    const column = solveLinearSystem(xtx.map((row) => [...row]), unit);
    standardErrors.push(Math.sqrt(Math.max(0, sigma2 * column[i]!)));
  }
  const tValues = coefficients.map((coef, i) => round(coef / standardErrors[i]!));
  const pValues = tValues.map((t) => round(2 * (1 - normalCdf(Math.abs(t)))));
  const adjRSquared = 1 - (1 - rSquared) * ((n - 1) / df);

  // 复核通道：中心化 + 均值回归（不依赖截距列），斜率独立重算。
  const means = Array.from({ length: k }, (_, j) => X.reduce((sum, row) => sum + (row[j] ?? 0), 0) / n);
  const meanYc = y.reduce((sum, value) => sum + value, 0) / n;
  // 单自变量快捷复核。
  let verificationCoefficients: number[];
  if (k === 1) {
    let sxy = 0;
    let sxx = 0;
    for (let index = 0; index < n; index += 1) {
      const dx = (X[index]![0] ?? 0) - means[0]!;
      sxy += dx * (y[index]! - meanYc);
      sxx += dx * dx;
    }
    const slope = sxy / sxx;
    const intercept = meanYc - slope * means[0]!;
    verificationCoefficients = [round(intercept), round(slope)];
  } else {
    // 多元：中心化正规方程复核。
    const centered = X.map((row) => row.map((value, j) => value - means[j]!));
    const yc = y.map((value) => value - meanYc);
    const cxtx: number[][] = Array.from({ length: k }, () => Array.from({ length: k }, () => 0));
    const cxty: number[] = Array.from({ length: k }, () => 0);
    for (let index = 0; index < n; index += 1) {
      for (let i = 0; i < k; i += 1) {
        cxty[i]! += centered[index]![i]! * yc[index]!;
        for (let j = 0; j < k; j += 1) {
          cxtx[i]![j]! += centered[index]![i]! * centered[index]![j]!;
        }
      }
    }
    const slopes = solveLinearSystem(cxtx, cxty);
    const intercept = meanYc - slopes.reduce((sum, slope, j) => sum + slope * means[j]!, 0);
    verificationCoefficients = [round(intercept), ...slopes.map(round)];
  }
  const verified = coefficients.every((coef, i) => Math.abs(coef - verificationCoefficients[i]!) <= Math.max(1e-8, Math.abs(coef) * 1e-6));

  return {
    n,
    coefficients: coefficients.map(round),
    standardErrors: standardErrors.map(round),
    tValues,
    pValues,
    rSquared: round(rSquared),
    adjRSquared: round(adjRSquared),
    verificationCoefficients,
    verified,
  };
}

/** 已知解校验（T6.3）：Anscombe I 组数据，回归线已知 y=3.00+0.500x。 */
export function runBuiltInChecks(): { ok: boolean; failures: string[] } {
  const failures: string[] = [];
  const anscombeX = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5];
  const anscombeY = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68];
  const fit = ols(anscombeX.map((x) => [x]), anscombeY);
  if (Math.abs(fit.coefficients[0]! - 3.0001) > 0.001) failures.push(`anscombe intercept ${fit.coefficients[0]}`);
  if (Math.abs(fit.coefficients[1]! - 0.5001) > 0.001) failures.push(`anscombe slope ${fit.coefficients[1]}`);
  if (Math.abs(fit.rSquared - 0.666) > 0.002) failures.push(`anscombe r2 ${fit.rSquared}`);
  if (!fit.verified) failures.push('anscombe dual-channel verification failed');
  const desc = describe(anscombeX);
  if (Math.abs(desc.mean - 9.0) > 1e-9) failures.push(`describe mean ${desc.mean}`);
  if (desc.n !== 11) failures.push('describe n');
  const table = crosstab(
    [
      { g: 'A', y: '是' }, { g: 'A', y: '否' }, { g: 'A', y: '是' },
      { g: 'B', y: '否' }, { g: 'B', y: '否' }, { g: 'B', y: '否' },
    ],
    'g', 'y',
  );
  // colLabels 排序后为 ['否','是']：A行=（否1，是2），B行=（否3，是0）。
  if (table.cells[0]![1]!.value !== 2 || table.cells[1]![0]!.value !== 3) failures.push('crosstab counts');
  if (table.rowLabels.join('') !== 'AB') failures.push('crosstab labels');
  return { ok: failures.length === 0, failures };
}

/** 把结果转为 ComputedFact 数组（写作/QA 引用的唯一数字来源）。 */
export function describeToFacts(labelPrefix: string, result: DescribeResult): ComputedFact[] {
  return [
    makeComputedFact({ label: `${labelPrefix}样本量`, value: result.n, unit: '个', source: SOURCE }),
    makeComputedFact({ label: `${labelPrefix}均值`, value: result.mean, unit: '值', source: SOURCE }),
    makeComputedFact({ label: `${labelPrefix}标准差`, value: result.sd, unit: '值', source: SOURCE }),
    makeComputedFact({ label: `${labelPrefix}中位数`, value: result.median, unit: '值', source: SOURCE }),
  ];
}

export function olsToFacts(labelPrefix: string, xNames: string[], result: OlsResult): ComputedFact[] {
  const facts: ComputedFact[] = [
    makeComputedFact({ label: `${labelPrefix}样本量`, value: result.n, unit: '个', source: SOURCE }),
    makeComputedFact({ label: `${labelPrefix}R²`, value: result.rSquared, unit: '值', source: SOURCE }),
  ];
  result.coefficients.forEach((coef, index) => {
    const name = index === 0 ? '截距' : (xNames[index - 1] ?? `x${index}`);
    facts.push(makeComputedFact({ label: `${labelPrefix}系数(${name})`, value: coef, unit: '系数', source: SOURCE }));
    facts.push(makeComputedFact({ label: `${labelPrefix}p值(${name})`, value: result.pValues[index]!, unit: 'p', source: SOURCE }));
  });
  return facts;
}

function round(value: number): number {
  return Math.round(value * 1e6) / 1e6;
}
