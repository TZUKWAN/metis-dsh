/**
 * 可信度核查引擎（T6/T7/T8/T9）：ComputedFact、NumberConsistencyChecker、
 * MethodGate、ClaimAudit。
 */

import { describe, expect, it } from 'vitest';
import { fingerprintData, makeComputedFact, formatFactValue } from '../../engine/research/ComputedFact.js';
import { checkNumberConsistency, extractNumberDeclarations } from '../../engine/research/NumberConsistencyChecker.js';
import { checkMethod, suggestAlternatives } from '../../engine/research/MethodGate.js';
import { auditClaims, extractClaimedBehaviors } from '../../engine/research/ClaimAudit.js';

const SOURCE = {
  kind: 'statistics' as const,
  engine: 'metis-stats/1',
  dataFingerprint: 'abc123',
  seed: 42,
  runId: null,
};

describe('ComputedFact（T6）', () => {
  it('数字事实带引擎/数据指纹/种子溯源', () => {
    const fact = makeComputedFact({ label: '女性占比', value: 58.0, unit: '%', source: SOURCE });
    expect(fact.source.engine).toBe('metis-stats/1');
    expect(fact.source.seed).toBe(42);
    expect(fact.formatted).toBe('58%');
    expect(fact.id).toMatch(/^fact-metis-stats\/1-/);
  });

  it('数据指纹对内容敏感且稳定', () => {
    expect(fingerprintData('a,b\n1,2')).toBe(fingerprintData('a,b\n1,2'));
    expect(fingerprintData('a,b\n1,2')).not.toBe(fingerprintData('a,b\n1,3'));
  });

  it('p 值与系数的规范呈现', () => {
    expect(formatFactValue(0.0000001, 'p')).toBe('p<0.001');
    expect(formatFactValue(0.035, 'p')).toBe('p=0.035');
    expect(formatFactValue(0.351234, '系数')).toBe('0.351234');
  });
});

describe('NumberConsistencyChecker（T7）', () => {
  const facts = [
    makeComputedFact({ label: '样本量', value: 1200, unit: '个', source: SOURCE }),
    makeComputedFact({ label: '女性占比', value: 55.2, unit: '%', source: SOURCE }),
    makeComputedFact({ label: '教育回报系数', value: 0.081, unit: '系数', source: SOURCE }),
  ];

  it('抽取文本中的数字声明并忽略年份/图表编号噪音', () => {
    const text = '基于 2023 年调查数据（N=1,200），女性占比 55.2%，见图 3。';
    const declarations = extractNumberDeclarations(text);
    const raws = declarations.map((d) => d.raw);
    expect(raws).toContain('N=1,200');
    expect(raws).toContain('55.2%');
    expect(raws).not.toContain('2023');
  });

  it('一致数字标记 matched，冲突数字标记 mismatch', () => {
    const text = '样本量 N=1,200，女性占比 58%（正文声明），系数为 0.081。';
    const report = checkNumberConsistency(text, facts);
    const byRaw = new Map(report.declarations.map((d) => [d.raw, d]));
    expect(byRaw.get('N=1,200')!.status).toBe('matched');
    expect(byRaw.get('0.081')!.status).toBe('matched');
    expect(byRaw.get('58%')!.status).toBe('mismatch');
    expect(report.ok).toBe(false);
  });

  it('无依据数字标记 unverifiable', () => {
    const report = checkNumberConsistency('共收集了 340 份有效问卷。', facts);
    expect(report.declarations[0]!.status).toBe('unverifiable');
    expect(report.counts.unverifiable).toBe(1);
  });
});

describe('MethodGate（T8）', () => {
  it('小样本 + 内生性场景下 OLS 被拦截并给出警告', () => {
    const result = checkMethod('ols', { sampleSize: 18, endogeneitySuspected: true, outcomeType: 'continuous' });
    expect(result.pass).toBe(false);
    const warningKeys = result.warnings.map((w) => w.warningKey);
    expect(warningKeys).toContain('ols.sample');
    expect(warningKeys).toContain('ols.endogeneity');
  });

  it('满足条件时 OLS 通过', () => {
    const result = checkMethod('ols', { sampleSize: 800, endogeneitySuspected: false, outcomeType: 'continuous', missingRatio: 0.02 });
    expect(result.pass).toBe(true);
  });

  it('DID 未做平行趋势检验时警告', () => {
    expect(checkMethod('did', { parallelTrendTested: false }).pass).toBe(false);
    expect(checkMethod('did', { parallelTrendTested: true }).pass).toBe(true);
  });

  it('按上下文推荐可用的替代方法', () => {
    const alternatives = suggestAlternatives({ sampleSize: 800, outcomeType: 'continuous', endogeneitySuspected: false, missingRatio: 0.02 });
    expect(alternatives).toContain('ols');
  });
});

describe('ClaimAudit（T9）', () => {
  it('从文本抽取行为声明（含次数与不含次数）', () => {
    const claims = extractClaimedBehaviors('我检索了 30 篇文献，并阅读了全文。');
    expect(claims.some((c) => c.operation === 'search' && c.count === 30)).toBe(true);
    expect(claims.some((c) => c.operation === 'read_pdf' && c.count === null)).toBe(true);
  });

  it('声称超过实际记录判定 overclaimed，零记录判定 unsupported', () => {
    const claims = extractClaimedBehaviors('我检索了 30 篇文献，并阅读了全文。');
    const result = auditClaims(claims, [
      { operation: 'search', count: 5 },
    ]);
    const byOp = new Map(result.claims.map((item) => [item.claimed.operation, item]));
    expect(byOp.get('search')!.verdict).toBe('overclaimed');
    expect(byOp.get('read_pdf')!.verdict).toBe('unsupported');
    expect(result.ok).toBe(false);
  });

  it('声称与实际一致时 supported 且 ok', () => {
    const claims = extractClaimedBehaviors('我检索了 30 篇文献。');
    const result = auditClaims(claims, [{ operation: 'search', count: 30 }]);
    expect(result.claims[0]!.verdict).toBe('supported');
    expect(result.ok).toBe(true);
  });

  it('账本里有但未声称的操作进入 unclaimedOperations', () => {
    const result = auditClaims([], [{ operation: 'search', count: 3 }]);
    expect(result.unclaimedOperations).toEqual([{ operation: 'search', count: 3 }]);
  });
});
