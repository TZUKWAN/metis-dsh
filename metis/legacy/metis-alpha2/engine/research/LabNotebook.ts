/**
 * Lab Notebook — immutable experiment run log.
 *
 * Tracks each experiment execution with:
 *   - Unique run ID + timestamp
 *   - Parameter snapshot (frozen at run time)
 *   - Metric results
 *   - Environment fingerprint (OS, Python version, pip freeze)
 *   - Multiple runs for trend/variance analysis
 */

import type { ExperimentRunResult } from './ExperimentReproducer.js';

// ─── Types ──────────────────────────────────────────────────

export interface LabNotebookEntry {
  /** Unique run identifier */
  runId: string;
  /** Experiment this run belongs to */
  experimentId: string;
  /** Experiment name */
  experimentName: string;
  /** When this run was executed */
  timestamp: number;
  /** Parameter snapshot at time of execution */
  params: Record<string, string>;
  /** Metric results */
  metrics: Record<string, number[]>;
  /** Exit code */
  exitCode: number | null;
  /** Execution duration in ms */
  durationMs: number;
  /** Environment info */
  environment: {
    os: string;
    node: string;
    python?: string;
    cwd: string;
  };
  /** Raw stdout (truncated) */
  stdout: string;
  /** Raw stderr (truncated) */
  stderr: string;
  /** User notes on this run */
  notes: string;
  /** Whether this run was a re-run of a previous configuration */
  isReplay: boolean;
  /** Reference to original run if this is a replay */
  originalRunId?: string;
}

export interface RunStats {
  runCount: number;
  params: Record<string, string>;
  /** Metric statistics per metric key */
  metricStats: Record<string, {
    values: number[];
    mean: number;
    std: number;
    min: number;
    max: number;
    count: number;
  }>;
  firstRun: number;
  lastRun: number;
}

// ─── Lab Notebook ──────────────────────────────────────────

export class LabNotebook {
  private entries = new Map<string, LabNotebookEntry[]>();

  /** Record a new experiment run. */
  record(
    experimentId: string,
    experimentName: string,
    params: Record<string, string>,
    runResult: ExperimentRunResult,
    options?: {
      notes?: string;
      isReplay?: boolean;
      originalRunId?: string;
      pythonVersion?: string;
    },
  ): LabNotebookEntry {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

    const entry: LabNotebookEntry = {
      runId,
      experimentId,
      experimentName,
      timestamp: Date.now(),
      params: { ...params },
      metrics: {}, // Populate later via addMetrics
      exitCode: runResult.exitCode,
      durationMs: runResult.durationMs,
      environment: {
        os: process.platform,
        node: process.version,
        python: options?.pythonVersion,
        cwd: process.cwd(),
      },
      stdout: runResult.stdout.slice(0, 5000),
      stderr: runResult.stderr.slice(0, 1000),
      notes: options?.notes ?? '',
      isReplay: options?.isReplay ?? false,
      originalRunId: options?.originalRunId,
    };

    const existing = this.entries.get(experimentId) ?? [];
    existing.push(entry);
    this.entries.set(experimentId, existing);

    return entry;
  }

  /** Add metrics to an existing run entry. */
  addMetrics(runId: string, metrics: Record<string, number>): boolean {
    for (const [, runs] of this.entries) {
      const entry = runs.find((r) => r.runId === runId);
      if (entry) {
        for (const [key, value] of Object.entries(metrics)) {
          if (!entry.metrics[key]) entry.metrics[key] = [];
          entry.metrics[key]!.push(value);
        }
        return true;
      }
    }
    return false;
  }

  /** Get all runs for an experiment. */
  getRuns(experimentId: string): LabNotebookEntry[] {
    return this.entries.get(experimentId) ?? [];
  }

  /** Get the most recent run for an experiment. */
  getLatestRun(experimentId: string): LabNotebookEntry | undefined {
    const runs = this.getRuns(experimentId);
    return runs.length > 0 ? runs[runs.length - 1] : undefined;
  }

  /** Compute statistics across runs for an experiment. */
  getRunStats(experimentId: string): RunStats | null {
    const runs = this.getRuns(experimentId);
    if (runs.length === 0) return null;

    const firstRun = runs[0]!;
    const lastRun = runs[runs.length - 1]!;

    // Aggregate metric stats
    const metricStats: RunStats['metricStats'] = {};
    for (const run of runs) {
      for (const [key, values] of Object.entries(run.metrics)) {
        if (!metricStats[key]) {
          metricStats[key] = { values: [], mean: 0, std: 0, min: Infinity, max: -Infinity, count: 0 };
        }
        for (const v of values) {
          metricStats[key]!.values.push(v);
        }
      }
    }

    for (const [, stats] of Object.entries(metricStats)) {
      const vals = stats.values;
      stats.count = vals.length;
      stats.mean = vals.reduce((s, v) => s + v, 0) / vals.length;
      stats.std = Math.sqrt(
        vals.reduce((s, v) => s + (v - stats.mean) ** 2, 0) / vals.length,
      );
      stats.min = Math.min(...vals);
      stats.max = Math.max(...vals);
    }

    return {
      runCount: runs.length,
      params: firstRun.params,
      metricStats,
      firstRun: firstRun.timestamp,
      lastRun: lastRun.timestamp,
    };
  }

  /**
   * Format run statistics as a human-readable research log.
   */
  formatStats(experimentId: string): string {
    const stats = this.getRunStats(experimentId);
    const runs = this.getRuns(experimentId);

    if (!stats || runs.length === 0) {
      return `No runs recorded for experiment '${experimentId}'.`;
    }

    const lines: string[] = [
      `# Lab Notebook: ${runs[0]?.experimentName ?? experimentId}`,
      '',
      `**Runs**: ${stats.runCount} | **First**: ${new Date(stats.firstRun).toISOString()} | **Last**: ${new Date(stats.lastRun).toISOString()}`,
      `**Environment**: ${runs[0]?.environment.os}, Node ${runs[0]?.environment.node}${runs[0]?.environment.python ? `, Python ${runs[0].environment.python}` : ''}`,
      '',
      '## Parameters',
      ...Object.entries(stats.params).map(([k, v]) => `- ${k}: ${v}`),
      '',
      '## Metrics',
    ];

    if (Object.keys(stats.metricStats).length === 0) {
      lines.push('No metrics recorded.');
    } else {
      for (const [key, s] of Object.entries(stats.metricStats)) {
        lines.push(`### ${key}`);
        lines.push(`- Mean: ${s.mean.toFixed(4)} ± ${s.std.toFixed(4)}`);
        lines.push(`- Range: [${s.min.toFixed(4)}, ${s.max.toFixed(4)}]`);
        lines.push(`- Count: ${s.count}`);
        if (stats.runCount > 1) {
          // Trend line: show values across runs
          const trendVals = runs.map((r) => {
            const vals = r.metrics[key] ?? [];
            return vals.length > 0 ? vals[vals.length - 1]! : null;
          }).filter((v): v is number => v !== null);
          if (trendVals.length > 1) {
            lines.push(`- Trend: ${trendVals.map((v) => v.toFixed(4)).join(' → ')}`);
          }
        }
        lines.push('');
      }
    }

    return lines.join('\n');
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: LabNotebook | null = null;

export function getLabNotebook(): LabNotebook {
  if (!_instance) {
    _instance = new LabNotebook();
  }
  return _instance;
}
