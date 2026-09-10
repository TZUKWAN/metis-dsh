/**
 * MethodGate — 方法适切性门（T8）。
 *
 * 社科论文被毙最常见的原因不是算错，而是方法用错。每个统计方法配适用
 * 条件知识库；AI/用户选方法时先跑前置检查，不满足则警告并给替代建议。
 * 确定性规则，零模型调用。
 */

export type StatisticalMethodId =
  | 'ols'
  | 'logistic'
  | 'did'
  | 'iv'
  | 'rd'
  | 'sem'
  | 'panel'
  | 'grounded_coding';

export interface MethodContext {
  sampleSize?: number;
  /** 因变量类型：continuous/binary/ordinal/count。 */
  outcomeType?: 'continuous' | 'binary' | 'ordinal' | 'count';
  /** 是否存在可疑的内生性来源（自选择/遗漏变量/双向因果）。 */
  endogeneitySuspected?: boolean;
  /** 是否有可用工具变量。 */
  hasInstrument?: boolean;
  /** DID：处理组与控制组是否满足平行趋势（前趋势检验通过）。 */
  parallelTrendTested?: boolean;
  /** 缺失值比例（0-1）。 */
  missingRatio?: number;
  /** 定性编码：是否已有编码手册与至少二次独立编码。 */
  secondCoderAvailable?: boolean;
}

export interface MethodRequirement {
  key: string;
  check: (context: MethodContext) => boolean;
  warningKey: string;
  suggestionKey: string;
}

export interface MethodGateResult {
  method: StatisticalMethodId;
  pass: boolean;
  warnings: Array<{ warningKey: string; suggestionKey: string; detailKey: string }>;
}

const METHODS: Record<StatisticalMethodId, { requirements: MethodRequirement[] }> = {
  ols: {
    requirements: [
      {
        key: 'sample',
        check: (c) => (c.sampleSize ?? 0) >= 30,
        warningKey: 'ols.sample',
        suggestionKey: 'ols.sampleSuggestion',
      },
      {
        key: 'endogeneity',
        check: (c) => !c.endogeneitySuspected || c.hasInstrument === true,
        warningKey: 'ols.endogeneity',
        suggestionKey: 'ols.endogeneitySuggestion',
      },
      {
        key: 'outcome',
        check: (c) => c.outcomeType === undefined || c.outcomeType === 'continuous',
        warningKey: 'ols.outcome',
        suggestionKey: 'ols.outcomeSuggestion',
      },
      {
        key: 'missing',
        check: (c) => (c.missingRatio ?? 0) <= 0.2,
        warningKey: 'ols.missing',
        suggestionKey: 'ols.missingSuggestion',
      },
    ],
  },
  logistic: {
    requirements: [
      {
        key: 'outcome',
        check: (c) => c.outcomeType === 'binary',
        warningKey: 'logistic.outcome',
        suggestionKey: 'logistic.outcomeSuggestion',
      },
      {
        key: 'sample',
        // 每个自变量至少 10 个事件（经验法则的简化版：总量 ≥100）。
        check: (c) => (c.sampleSize ?? 0) >= 100,
        warningKey: 'logistic.sample',
        suggestionKey: 'logistic.sampleSuggestion',
      },
    ],
  },
  did: {
    requirements: [
      {
        key: 'parallel',
        check: (c) => c.parallelTrendTested === true,
        warningKey: 'did.parallel',
        suggestionKey: 'did.parallelSuggestion',
      },
      {
        key: 'endogeneity',
        check: (c) => !c.endogeneitySuspected,
        warningKey: 'did.endogeneity',
        suggestionKey: 'did.endogeneitySuggestion',
      },
    ],
  },
  iv: {
    requirements: [
      {
        key: 'instrument',
        check: (c) => c.hasInstrument === true,
        warningKey: 'iv.instrument',
        suggestionKey: 'iv.instrumentSuggestion',
      },
    ],
  },
  rd: {
    requirements: [
      {
        key: 'runningVar',
        check: () => true,
        warningKey: 'rd.runningVar',
        suggestionKey: 'rd.runningVarSuggestion',
      },
    ],
  },
  sem: {
    requirements: [
      {
        key: 'sample',
        check: (c) => (c.sampleSize ?? 0) >= 200,
        warningKey: 'sem.sample',
        suggestionKey: 'sem.sampleSuggestion',
      },
      {
        key: 'missing',
        check: (c) => (c.missingRatio ?? 0) <= 0.1,
        warningKey: 'sem.missing',
        suggestionKey: 'sem.missingSuggestion',
      },
    ],
  },
  panel: {
    requirements: [
      {
        key: 'sample',
        check: (c) => (c.sampleSize ?? 0) >= 50,
        warningKey: 'panel.sample',
        suggestionKey: 'panel.sampleSuggestion',
      },
    ],
  },
  grounded_coding: {
    requirements: [
      {
        key: 'secondCoder',
        check: (c) => c.secondCoderAvailable !== false,
        warningKey: 'coding.secondCoder',
        suggestionKey: 'coding.secondCoderSuggestion',
      },
    ],
  },
};

export function checkMethod(method: StatisticalMethodId, context: MethodContext): MethodGateResult {
  const definition = METHODS[method];
  if (!definition) {
    return { method, pass: true, warnings: [] };
  }
  const warnings = definition.requirements
    .filter((requirement) => !requirement.check(context))
    .map((requirement) => ({
      warningKey: requirement.warningKey,
      suggestionKey: requirement.suggestionKey,
      detailKey: `methodGate.${requirement.warningKey}`,
    }));
  return { method, pass: warnings.length === 0, warnings };
}

/** 推荐替代方法：当前方法未过门时，按上下文找全部通过的方法。 */
export function suggestAlternatives(context: MethodContext): StatisticalMethodId[] {
  return (Object.keys(METHODS) as StatisticalMethodId[]).filter((method) => checkMethod(method, context).pass);
}
