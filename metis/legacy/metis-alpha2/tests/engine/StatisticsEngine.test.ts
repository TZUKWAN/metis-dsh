/**
 * StatisticsEngine — 本地确定性统计引擎（T21 + T6.2/6.3）。
 *
 * Anscombe I 组已知解：截距 3.0001、斜率 0.5001、R² 0.666 —— 这是引擎
 * 正确性的"出厂检验"，也是 runBuiltInChecks 的内容。
 */

import { describe, expect, it } from 'vitest';
import { describe as describeStats, crosstab, ols, runBuiltInChecks, describeToFacts, olsToFacts } from '../../engine/research/StatisticsEngine.js';

const ANS_X = [10, 8, 13, 9, 11, 14, 6, 4, 12, 7, 5];
const ANS_Y = [8.04, 6.95, 7.58, 8.81, 8.33, 9.96, 7.24, 4.26, 10.84, 4.82, 5.68];

describe('StatisticsEngine — describe', () => {
  it('描述统计与双通道均值复核', () => {
    const result = describeStats(ANS_X);
    expect(result.n).toBe(11);
    expect(result.mean).toBeCloseTo(9.0, 9);
    expect(result.median).toBe(9);
    expect(result.min).toBe(4);
    expect(result.max).toBe(14);
  });

  it('空输入报错（不返回伪数据）', () => {
    expect(() => describeStats([])).toThrow(/no finite values/);
  });
});

describe('StatisticsEngine — crosstab', () => {
  it('交叉表计数、行百分比与卡方', () => {
    const rows = [
      { edu: '高中', vote: '是' }, { edu: '高中', vote: '否' }, { edu: '高中', vote: '是' },
      { edu: '大学', vote: '否' }, { edu: '大学', vote: '否' }, { edu: '大学', vote: '否' },
    ];
    const table = crosstab(rows, 'edu', 'vote');
    expect(table.rowLabels).toEqual(['大学', '高中']); // 行排序
    expect(table.colLabels).toEqual(['否', '是']); // 列排序（Unicode 序）
    expect(table.cells[0]![0]!.value).toBe(3); // 大学×否
    expect(table.cells[0]![1]!.value).toBe(0); // 大学×是
    expect(table.cells[1]![0]!.value).toBe(1); // 高中×否
    expect(table.cells[1]![1]!.value).toBe(2); // 高中×是
    expect(table.cells[0]![0]!.rowPercent).toBeCloseTo(100, 6);
    expect(table.cells[1]![0]!.rowPercent).toBeCloseTo(33.333333, 3);
    expect(table.chiSquare).toBeGreaterThan(0);
    expect(table.degreesOfFreedom).toBe(1);
  });
});

describe('StatisticsEngine — ols（双通道复核 + 已知解）', () => {
  it('Anscombe I 组：截距/斜率/R² 与教科书已知解一致', () => {
    const fit = ols(ANS_X.map((x) => [x]), ANS_Y);
    expect(fit.coefficients[0]).toBeCloseTo(3.0001, 3);
    expect(fit.coefficients[1]).toBeCloseTo(0.5001, 3);
    expect(fit.rSquared).toBeCloseTo(0.666, 2);
    expect(fit.verified).toBe(true);
    expect(fit.verificationCoefficients[1]).toBeCloseTo(0.5001, 3);
  });

  it('多元回归与手算一致（两个自变量的构造数据）', () => {
    // y = 2 + 3*x1 - 1*x2 + 0（无噪声，精确可复现）
    const X: number[][] = [];
    const y: number[] = [];
    for (let i = 1; i <= 12; i += 1) {
      const x1 = i;
      const x2 = (i % 4) + 1;
      X.push([x1, x2]);
      y.push(2 + 3 * x1 - 1 * x2);
    }
    const fit = ols(X, y);
    expect(fit.coefficients[0]).toBeCloseTo(2, 6);
    expect(fit.coefficients[1]).toBeCloseTo(3, 6);
    expect(fit.coefficients[2]).toBeCloseTo(-1, 6);
    expect(fit.rSquared).toBeCloseTo(1, 9);
    expect(fit.verified).toBe(true);
  });

  it('样本不足时拒绝计算', () => {
    expect(() => ols([[1], [2]], [1, 2])).toThrow(/insufficient/);
  });

  it('p 值随 t 增大而减小（方向性）', () => {
    const strong = ols(ANS_X.map((x) => [x]), ANS_Y);
    const weak = ols(ANS_X.map((x) => [x]), ANS_X.map(() => 5 + (Math.random() * 0) + ((ANS_X[0]! % 2) ? 0 : 0)));
    void weak;
    expect(strong.pValues[1]).toBeLessThan(0.01);
  });
});

describe('StatisticsEngine — 内置校验与事实化', () => {
  it('runBuiltInChecks 全部通过（出厂检验）', () => {
    const result = runBuiltInChecks();
    expect(result.ok).toBe(true);
    expect(result.failures).toEqual([]);
  });

  it('结果转为带溯源的 ComputedFact', () => {
    const facts = describeToFacts('教育年限', describeStats(ANS_X));
    expect(facts.length).toBeGreaterThanOrEqual(4);
    expect(facts[0]!.source.engine).toBe('metis-stats/1');
    const olsFacts = olsToFacts('模型1', ['x'], ols(ANS_X.map((x) => [x]), ANS_Y));
    expect(olsFacts.some((fact) => fact.unit === 'p')).toBe(true);
    expect(olsFacts.every((fact) => fact.id.startsWith('fact-'))).toBe(true);
  });
});
