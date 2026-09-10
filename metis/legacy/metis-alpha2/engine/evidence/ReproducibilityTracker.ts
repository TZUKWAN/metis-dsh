/**
 * Reproducibility Tracker — multi-environment run verification.
 *
 * Tracks experiment runs across different environments/machines/times
 * to verify that results are reproducible, not one-off flukes.
 *
 * Key features:
 *   - Run ID with hash-based content integrity
 *   - Environment fingerprinting (OS, runtime versions, timestamps)
 *   - Deterministic vs stochastic result classification
 *   - Multi-run variance analysis
 */

import { createHash } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────

export interface ReproducibilityRun {
  /** Unique run identifier (hash of content) */
  runId: string;
  /** When executed */
  timestamp: number;
  /** Environment fingerprint */
  env: {
    os: string;
    arch: string;
    nodeVersion: string;
    pythonVersion?: string;
    hostname?: string;
  };
  /** Command executed */
  command: string;
  /** Exit code */
  exitCode: number | null;
  /** Content hash of stdout (for integrity verification) */
  stdoutHash: string;
  /** Content hash of stderr */
  stderrHash: string;
  /** Whether this result is deterministic (exact match) or stochastic */
  resultType: 'deterministic' | 'stochastic';
  /** Duration in ms */
  durationMs: number;
  /** Numeric metrics extracted from output */
  metrics: Record<string, number>;
}

export interface ReproducibilityReport {
  /** Total runs recorded */
  totalRuns: number;
  /** How many unique environments */
  uniqueEnvs: number;
  /** How many runs match deterministically */
  deterministicMatches: number;
  /** Reproducibility score (0-100) */
  score: number;
  /** Detailed per-metric stats */
  metricAnalysis: Record<string, {
    values: number[];
    mean: number;
    std: number;
    cv: number; // Coefficient of variation
  }>;
  /** Verdict */
  verdict: string;
}

// ─── Hash Engine ──────────────────────────────────────────

function contentHash(content: string): string {
  return createHash('sha256').update(content).digest('hex').slice(0, 16);
}

// ─── Reproducibility Tracker ──────────────────────────────

export class ReproducibilityTracker {
  private runs = new Map<string, ReproducibilityRun[]>();

  /**
   * Record a new run and verify against previous runs.
   */
  record(options: {
    experimentId: string;
    command: string;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    durationMs: number;
    pythonVersion?: string;
    metrics?: Record<string, number>;
  }): ReproducibilityRun {
    const run: ReproducibilityRun = {
      runId: `repr-${contentHash(options.stdout + options.stderr + Date.now().toString())}`,
      timestamp: Date.now(),
      env: {
        os: process.platform,
        arch: process.arch,
        nodeVersion: process.version,
        pythonVersion: options.pythonVersion,
        hostname: process.env['COMPUTERNAME'] ?? process.env['HOSTNAME'],
      },
      command: options.command,
      exitCode: options.exitCode,
      stdoutHash: contentHash(options.stdout),
      stderrHash: contentHash(options.stderr),
      resultType: 'deterministic', // Will be refined after comparison
      durationMs: options.durationMs,
      metrics: options.metrics ?? {},
    };

    // Compare with previous runs to classify determinism
    const existing = this.runs.get(options.experimentId) ?? [];
    if (existing.length > 0) {
      const lastRun = existing[existing.length - 1]!;
      if (lastRun.stdoutHash === run.stdoutHash && lastRun.exitCode === run.exitCode) {
        run.resultType = 'deterministic';
      } else {
        run.resultType = 'stochastic';
      }
    }

    existing.push(run);
    this.runs.set(options.experimentId, existing);

    return run;
  }

  /**
   * Generate a reproducibility report.
   */
  generateReport(experimentId: string): ReproducibilityReport | null {
    const runs = this.runs.get(experimentId);
    if (!runs || runs.length === 0) return null;

    const envs = new Set(runs.map((r) => `${r.env.os}-${r.env.hostname ?? 'unknown'}`));
    const deterministicRuns = runs.filter((r) => r.resultType === 'deterministic').length;

    // Score: high if many runs + deterministic + multi-env
    let score = 0;
    if (runs.length >= 3) score += 30;
    else if (runs.length >= 2) score += 15;
    if (envs.size >= 2) score += 20;
    if (deterministicRuns >= runs.length * 0.7) score += 30;
    else if (deterministicRuns >= runs.length * 0.5) score += 15;
    if (!runs.some((r) => r.exitCode !== 0)) score += 20;

    // Metric analysis
    const metricAnalysis: ReproducibilityReport['metricAnalysis'] = {};
    for (const run of runs) {
      for (const [key, value] of Object.entries(run.metrics)) {
        if (!metricAnalysis[key]) {
          metricAnalysis[key] = { values: [], mean: 0, std: 0, cv: 0 };
        }
        metricAnalysis[key]!.values.push(value);
      }
    }

    for (const [, stats] of Object.entries(metricAnalysis)) {
      const vals = stats.values;
      stats.mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      stats.std = Math.sqrt(vals.reduce((s, v) => s + (v - stats.mean) ** 2, 0) / vals.length);
      stats.cv = stats.mean !== 0 ? stats.std / Math.abs(stats.mean) : 0;
    }

    let verdict: string;
    if (score >= 80) verdict = '[通过] 高度可复现 — 多次运行结果一致，适合发表';
    else if (score >= 60) verdict = '[警告] 部分可复现 — 存在随机性，建议在论文中报告方差';
    else if (score >= 40) verdict = '[警告] 可复现性不确定 — 运行次数不足或存在环境差异';
    else verdict = '[失败] 不可复现 — 多次运行结果不一致，需要排查原因';

    return {
      totalRuns: runs.length,
      uniqueEnvs: envs.size,
      deterministicMatches: deterministicRuns,
      score,
      metricAnalysis,
      verdict,
    };
  }

  /**
   * Format report as markdown.
   */
  formatReport(experimentId: string): string {
    const report = this.generateReport(experimentId);
    const runs = this.runs.get(experimentId) ?? [];

    if (!report || runs.length === 0) {
      return `No reproducibility data for experiment '${experimentId}'.`;
    }

    const lines: string[] = [
      `# Reproducibility Report`,
      '',
      `**Score**: ${report.score}/100`,
      `**Verdict**: ${report.verdict}`,
      '',
      `**Runs**: ${report.totalRuns} | **Environments**: ${report.uniqueEnvs} | **Deterministic**: ${report.deterministicMatches}/${report.totalRuns}`,
      '',
      `## Metric Analysis`,
    ];

    for (const [key, stats] of Object.entries(report.metricAnalysis)) {
      const stabilityClass = stats.cv < 0.05 ? '[正常] 稳定' : stats.cv < 0.15 ? '[注意] 中等' : '[严重] 波动';
      lines.push(`- **${key}**: mean=${stats.mean.toFixed(4)} ± ${stats.std.toFixed(4)} (CV: ${(stats.cv * 100).toFixed(1)}%) ${stabilityClass}`);
    }

    lines.push('', '## Run History', '');
    for (const run of runs) {
      lines.push(`- ${new Date(run.timestamp).toISOString()} | ${run.env.os} | exit=${run.exitCode} | ${run.durationMs}ms | ${run.resultType} | hash=${run.stdoutHash}`);
    }

    return lines.join('\n');
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: ReproducibilityTracker | null = null;

export function getReproducibilityTracker(): ReproducibilityTracker {
  if (!_instance) {
    _instance = new ReproducibilityTracker();
  }
  return _instance;
}
