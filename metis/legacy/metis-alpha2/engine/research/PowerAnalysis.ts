/**
 * Statistical Power Analysis — helps researchers validate experiment design.
 *
 * Computes:
 *   - Minimum sample size for desired power
 *   - Achieved power for given sample/effect/alpha
 *   - Effect size estimation (Cohen's d)
 *   - Test recommendation (t-test, ANOVA, chi-square, etc.)
 *
 * All computations use standard statistical formulas.
 * No external dependencies.
 */

// ─── Types ──────────────────────────────────────────────────

export type TestType = 't_test_independent' | 't_test_paired' | 'anova' | 'chi_square' | 'correlation';

export interface PowerAnalysisInput {
  testType: TestType;
  effectSize?: number;    // Cohen's d / Cohen's f / Cohen's w
  alpha?: number;         // Significance level (default 0.05)
  power?: number;         // Desired power (default 0.80)
  sampleSize?: number;    // Sample size per group (if computing power)
  numGroups?: number;     // Number of groups (for ANOVA)
}

export interface PowerAnalysisResult {
  testType: TestType;
  /** Minimum sample size per group to achieve desired power */
  requiredSampleSize: number | null;
  /** Achieved power for given sample size */
  achievedPower: number | null;
  /** Effect size interpretation */
  effectSizeInterpretation: string;
  /** Recommendation */
  recommendation: string;
  /** How to report in paper */
  reportingTemplate: string;
}

// ─── Statistical Functions ─────────────────────────────────

/** Normal distribution CDF approximation (Abramowitz & Stegun) */
function normCDF(x: number): number {
  const a1 = 0.254829592;
  const a2 = -0.284496736;
  const a3 = 1.421413741;
  const a4 = -1.453152027;
  const a5 = 1.061405429;
  const p = 0.3275911;
  const sign = x < 0 ? -1 : 1;
  x = Math.abs(x) / Math.sqrt(2);
  const t = 1 / (1 + p * x);
  const y = 1 - (((((a5 * t + a4) * t) + a3) * t + a2) * t + a1) * t * Math.exp(-x * x);
  return 0.5 * (1 + sign * y);
}

/** Inverse normal CDF */
function normQuantile(p: number): number {
  if (p <= 0 || p >= 1) return 0;
  const a = [2.50662823884, -18.61500062529, 41.39119773534, -25.44106049637];
  const b = [-8.47351093090, 23.08336743743, -21.06224101826, 3.13082909833];
  const c = [0.3374754822726147, 0.9761690190917186, 0.1607979714918209, 0.0276438810333863, 0.0038405729373609, 0.0003951896511919, 0.0000321767881768, 0.0000002888167364, 0.0000003960315187];
  const y = p - 0.5;
  if (Math.abs(y) < 0.42) {
    const r = y * y;
    return y * (((a[3]! * r + a[2]!) * r + a[1]!) * r + a[0]!) / ((((b[3]! * r + b[2]!) * r + b[1]!) * r + b[0]!) * r + 1);
  }
  const r = p > 0.5 ? 1 - p : p;
  const s = Math.log(-Math.log(r));
  let z = c[0]! + s * (c[1]! + s * (c[2]! + s * (c[3]! + s * (c[4]! + s * (c[5]! + s * (c[6]! + s * (c[7]! + s * c[8]!)))))));
  if (p < 0.5) z = -z;
  return z;
}

// ─── Power Analysis Engine ─────────────────────────────────

export class PowerAnalysis {
  /**
   * Compute required sample size for two-sample t-test.
   * Formula: n = 2 * (z_alpha/2 + z_beta)^2 / d^2
   */
  computeTTestSampleSize(
    effectSize: number,
    alpha = 0.05,
    power = 0.80,
  ): number {
    const zAlpha = normQuantile(1 - alpha / 2);
    const zBeta = normQuantile(power);
    const n = 2 * Math.pow(zAlpha + zBeta, 2) / Math.pow(effectSize, 2);
    return Math.ceil(n);
  }

  /**
   * Compute achieved power for given sample size (two-sample t-test).
   */
  computeTTestPower(
    effectSize: number,
    sampleSize: number,
    alpha = 0.05,
  ): number {
    const zAlpha = normQuantile(1 - alpha / 2);
    const ncp = effectSize * Math.sqrt(sampleSize / 2);
    const power = 1 - normCDF(zAlpha - ncp) + normCDF(-zAlpha - ncp);
    return Math.min(1, Math.max(0, power));
  }

  /**
   * Compute required sample size for ANOVA.
   * Approximated using Cohen's f.
   */
  computeAnovaSampleSize(
    effectSizeF: number,
    numGroups: number,
    alpha = 0.05,
    power = 0.80,
  ): number {
    // Use non-central F approximation via t-test conversion
    const d = effectSizeF * 2; // Convert Cohen's f to approximate d
    const n = this.computeTTestSampleSize(d, alpha, power);
    return Math.ceil(n * numGroups);
  }

  /**
   * Compute Cohen's d from means and standard deviations.
   */
  cohensD(mean1: number, mean2: number, sd1: number, sd2: number): number {
    const pooledSD = Math.sqrt((sd1 * sd1 + sd2 * sd2) / 2);
    if (pooledSD === 0) return 0;
    return Math.abs(mean1 - mean2) / pooledSD;
  }

  /**
   * Interpret Cohen's d effect size.
   */
  interpretEffectSize(d: number): string {
    if (d < 0.2) return '可忽略 (d < 0.2)';
    if (d < 0.5) return '小效应 (0.2 ≤ d < 0.5)';
    if (d < 0.8) return '中等效应 (0.5 ≤ d < 0.8)';
    return '大效应 (d ≥ 0.8)';
  }

  /**
   * Recommend statistical test based on study design.
   */
  recommendTest(options: {
    numGroups: number;
    paired: boolean;
    outcomeType: 'continuous' | 'categorical' | 'count';
  }): TestType {
    if (options.outcomeType === 'categorical') return 'chi_square';
    if (options.numGroups === 2 && options.paired) return 't_test_paired';
    if (options.numGroups === 2) return 't_test_independent';
    if (options.numGroups > 2) return 'anova';
    return 'correlation';
  }

  /**
   * Full power analysis with recommendations.
   */
  analyze(input: PowerAnalysisInput): PowerAnalysisResult {
    const alpha = input.alpha ?? 0.05;
    const power = input.power ?? 0.80;
    const effectSize = input.effectSize ?? 0.5;

    let requiredSampleSize: number | null = null;
    let achievedPower: number | null = null;

    switch (input.testType) {
      case 't_test_independent':
      case 't_test_paired':
        if (input.sampleSize && effectSize) {
          achievedPower = this.computeTTestPower(effectSize, input.sampleSize, alpha);
        } else if (effectSize) {
          requiredSampleSize = this.computeTTestSampleSize(effectSize, alpha, power);
        }
        break;
      case 'anova':
        if (effectSize && (input.numGroups ?? 3) >= 2) {
          requiredSampleSize = this.computeAnovaSampleSize(effectSize, input.numGroups ?? 3, alpha, power);
        }
        break;
      case "chi_square":
        if (effectSize && effectSize > 0) {
          const zAlpha = normQuantile(1 - alpha / 2);
          const zBeta = normQuantile(power);
          requiredSampleSize = Math.ceil(Math.pow(zAlpha + zBeta, 2) / Math.pow(effectSize, 2));
        }
        break;

      case "correlation":
        if (effectSize && effectSize > 0 && effectSize < 1) {
          const zA = normQuantile(1 - alpha / 2);
          const zB = normQuantile(power);
          const fisherZ = Math.atanh(effectSize);
          requiredSampleSize = Math.ceil(Math.pow((zA + zB) / fisherZ, 2) + 3);
        }
        break;

      default:
        requiredSampleSize = this.computeTTestSampleSize(effectSize, alpha, power);
    }

    const effectInterpretation = this.interpretEffectSize(effectSize);

    let recommendation: string;
    let reportingTemplate: string;

    if (requiredSampleSize !== null) {
      recommendation = `要达到 ${(power * 100).toFixed(0)}% 统计功效，每组至少需要 ${requiredSampleSize} 个样本（效应量 d=${effectSize}, α=${alpha}）`;
      reportingTemplate = `A priori power analysis (G*Power / R pwr) indicated that N = ${requiredSampleSize} per group would be required to detect an effect size of d = ${effectSize} with ${(power * 100).toFixed(0)}% power at α = ${alpha} (${input.testType.replace(/_/g, ' ')}).`;
    } else if (achievedPower !== null) {
      recommendation = `当前样本量 (n=${input.sampleSize}) 的统计功效为 ${(achievedPower * 100).toFixed(0)}%。${achievedPower < 0.8 ? '建议增加样本量以提高功效。' : '功效充足。'}`;
      reportingTemplate = `Post hoc power analysis indicated that with n = ${input.sampleSize} per group, achieved power was ${(achievedPower * 100).toFixed(0)}% to detect d = ${effectSize} at α = ${alpha}.`;
    } else {
      recommendation = '需要提供效应量或样本量来进行功效分析。';
      reportingTemplate = 'Power analysis could not be performed.';
    }

    return {
      testType: input.testType,
      requiredSampleSize,
      achievedPower,
      effectSizeInterpretation: effectInterpretation,
      recommendation,
      reportingTemplate,
    };
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: PowerAnalysis | null = null;

export function getPowerAnalysis(): PowerAnalysis {
  if (!_instance) {
    _instance = new PowerAnalysis();
  }
  return _instance;
}
