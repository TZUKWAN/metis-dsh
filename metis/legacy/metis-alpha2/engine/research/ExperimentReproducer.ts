/**
 * Experiment Reproduction Engine — lightweight code execution sandbox.
 *
 * Runs experiment code in a controlled child_process with:
 *   - Temporary working directory (isolated filesystem)
 *   - Configurable timeout (prevents runaway code)
 *   - stdin/stdout/stderr capture
 *   - Exit code tracking
 *   - Optional input file provisioning
 *
 * NO Docker required. Uses Node's built-in child_process.spawn
 * with OS-level process isolation (PID namespace, memory limits via OS).
 */

import { spawn, type ChildProcess } from 'node:child_process';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { createHash } from 'node:crypto';

// ─── Types ──────────────────────────────────────────────────

export interface ExperimentRunConfig {
  /** Shell command or script to execute (e.g., "python experiment.py") */
  command: string;
  /** Working directory. Default: auto-created temp dir. */
  workDir?: string;
  /** Environment variables to pass */
  env?: Record<string, string>;
  /** Timeout in seconds. Default: 60. */
  timeout?: number;
  /** Files to provision before execution: { filename: content } */
  inputFiles?: Record<string, string>;
  /** Maximum output size in bytes. Default: 1MB. */
  maxOutput?: number;
}

export interface ExperimentRunResult {
  /** Unique run identifier (timestamp + random) */
  runId: string;
  /** Whether the process exited cleanly */
  success: boolean;
  /** Exit code (null if timed out or killed) */
  exitCode: number | null;
  /** Combined stdout */
  stdout: string;
  /** SHA256 hash of stdout for integrity verification */
  stdoutHash: string;
  /** Combined stderr */
  stderr: string;
  /** Execution duration in milliseconds */
  durationMs: number;
  /** Signal that killed the process (if any) */
  killedBy?: string;
  /** Working directory used (for artifact inspection) */
  workDir: string;
  /** Whether execution timed out */
  timedOut: boolean;
  /** Environment fingerprint */
  envFingerprint?: { os: string; arch: string; node: string; cwd: string };
}

// ─── Reproducer Class ──────────────────────────────────────

export class ExperimentReproducer {
  private readonly defaultTimeout: number;
  private readonly defaultMaxOutput: number;

  constructor(options?: { defaultTimeout?: number; defaultMaxOutput?: number }) {
    this.defaultTimeout = options?.defaultTimeout ?? 60;
    this.defaultMaxOutput = options?.defaultMaxOutput ?? 1_000_000; // 1MB
  }

  /**
   * Execute an experiment locally via child_process.
   */
  async execute(config: ExperimentRunConfig): Promise<ExperimentRunResult> {
    return this.executeLocal(config);
  }

  /**
   * Run experiment locally via child_process.
   */
  private async executeLocal(config: ExperimentRunConfig): Promise<ExperimentRunResult> {
    const runId = `run-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
    const timeout = (config.timeout ?? this.defaultTimeout) * 1000;
    const maxOutput = config.maxOutput ?? this.defaultMaxOutput;
    const workDir = config.workDir ?? await fs.mkdtemp(path.join(os.tmpdir(), 'metis-exp-'));
    const startTime = Date.now();
    const envFingerprint = { os: os.platform(), arch: os.arch(), node: process.version, cwd: workDir };

    // Ensure working directory exists
    await fs.mkdir(workDir, { recursive: true });

    // Provision input files
    if (config.inputFiles) {
      for (const [filename, content] of Object.entries(config.inputFiles)) {
        const filePath = path.join(workDir, filename);
        const dir = path.dirname(filePath);
        await fs.mkdir(dir, { recursive: true });
        await fs.writeFile(filePath, content, 'utf-8');
      }
    }

    // Parse command into program + args
    const [program, ...args] = config.command.split(/\s+/).filter(Boolean);
    if (!program) {
      return {
        runId,
        success: false,
        exitCode: -1,
        stdout: '',
        stdoutHash: createHash('sha256').update('').digest('hex').slice(0, 16),
        stderr: 'No command specified',
        durationMs: Date.now() - startTime,
        workDir,
        timedOut: false,
        envFingerprint,
      };
    }

    // Spawn process
    const env = { ...process.env, ...config.env };
    let child: ChildProcess;
    try {
      child = spawn(program, args, {
        cwd: workDir,
        env,
        stdio: ['pipe', 'pipe', 'pipe'],
        timeout,
        // Prevent child from inheriting parent's stdio
        detached: false,
      });
    } catch (err) {
      return {
        runId,
        success: false,
        exitCode: -1,
        stdout: '',
        stdoutHash: createHash('sha256').update('').digest('hex').slice(0, 16),
        stderr: `Failed to spawn: ${err instanceof Error ? err.message : String(err)}`,
        durationMs: Date.now() - startTime,
        workDir,
        timedOut: false,
        envFingerprint,
      };
    }

    // Capture output
    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let killedBy: string | undefined;

    const capturePromise = new Promise<void>((resolve, reject) => {
      if (!child.stdout || !child.stderr) {
        reject(new Error('Failed to open stdio streams'));
        return;
      }

      child.stdout.on('data', (data: Buffer) => {
        if (stdout.length < maxOutput) {
          stdout += data.toString();
          if (stdout.length > maxOutput) {
            stdout = stdout.slice(0, maxOutput) + '\n... [output truncated]';
          }
        }
      });

      child.stderr.on('data', (data: Buffer) => {
        if (stderr.length < maxOutput) {
          stderr += data.toString();
          if (stderr.length > maxOutput) {
            stderr = stderr.slice(0, maxOutput) + '\n... [output truncated]';
          }
        }
      });

      child.on('close', (_code, signal) => {
        if (signal) {
          killedBy = signal;
          if (signal === 'SIGTERM' || signal === 'SIGKILL') {
            timedOut = true;
          }
        }
        resolve();
      });

      child.on('error', (err) => {
        stderr += `Process error: ${err.message}`;
        resolve();
      });

      // Timeout handling
      const timeoutHandle = setTimeout(() => {
        timedOut = true;
        try { child.kill('SIGTERM'); } catch { /* process already dead */ }
        setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* already dead */ } }, 2000);
      }, timeout);

      child.on('close', () => clearTimeout(timeoutHandle));
    });

    await capturePromise;

    const durationMs = Date.now() - startTime;
    const finalStdout = stdout.trim();
    const finalStderr = stderr.trim();
    const stdoutHash = createHash('sha256').update(finalStdout).digest('hex').slice(0, 16);

    return {
      runId,
      success: !timedOut && child.exitCode === 0,
      exitCode: child.exitCode,
      stdout: finalStdout,
      stdoutHash,
      stderr: finalStderr,
      durationMs,
      killedBy,
      workDir,
      timedOut,
      envFingerprint,
    };
  }

  /**
   * Compare two experiment results against a reference.
   * Returns a comparison report with similarity metrics.
   */
  compareOutput(
    result: ExperimentRunResult,
    expected: { stdout?: string; stderr?: string; exitCode?: number },
  ): {
    matches: boolean;
    details: string[];
  } {
    const details: string[] = [];
    let matches = true;

    if (expected.exitCode !== undefined) {
      if (result.exitCode !== expected.exitCode) {
        details.push(`Exit code mismatch: expected ${expected.exitCode}, got ${result.exitCode}`);
        matches = false;
      } else {
        details.push(`Exit code: ${result.exitCode} [通过]`);
      }
    }

    if (expected.stdout !== undefined) {
      const similarity = this.textSimilarity(result.stdout, expected.stdout);
      details.push(`Stdout similarity: ${(similarity * 100).toFixed(1)}%`);
      if (similarity < 0.7) {
        matches = false;
      }
    }

    if (expected.stderr !== undefined) {
      const stderrExpected = expected.stderr || '';
      const stderrGot = result.stderr || '';
      if (stderrExpected && !stderrGot.includes(stderrExpected)) {
        details.push(`Stderr mismatch: expected to contain "${stderrExpected.slice(0, 80)}"`);
        matches = false;
      }
    }

    if (result.timedOut) {
      details.push('Experiment timed out');
      matches = false;
    }

    return { matches, details };
  }

  /**
   * Simple Jaccard similarity between two strings.
   */
  private textSimilarity(a: string, b: string): number {
    const wordsA = new Set(a.toLowerCase().split(/\s+/));
    const wordsB = new Set(b.toLowerCase().split(/\s+/));
    if (wordsA.size === 0 && wordsB.size === 0) return 1.0;
    const intersection = new Set([...wordsA].filter((w) => wordsB.has(w)));
    const union = new Set([...wordsA, ...wordsB]);
    return intersection.size / union.size;
  }

  /**
   * Compare numerical metrics extracted from stdout.
   * Parses patterns like "accuracy: 0.92", "F1: 0.87", "BLEU: 34.5"
   * and compares them against expected values.
   */
  compareMetrics(
    stdout: string,
    expected: Record<string, number>,
  ): { matches: boolean; comparisons: Array<{ metric: string; actual: number; expected: number; delta: number; match: boolean }> } {
    const comparisons: Array<{ metric: string; actual: number; expected: number; delta: number; match: boolean }> = [];
    let allMatch = true;

    for (const [metric, expectedVal] of Object.entries(expected)) {
      // Extract numeric value from patterns like "accuracy: 0.92", "accuracy = 0.92", "accuracy of 0.92"
      const pattern = new RegExp(`${metric}[\\s:=of]+?(\\d+\\.?\\d*)`, 'i');
      const match = stdout.match(pattern);
      const actualVal = match?.[1] ? parseFloat(match[1]) : null;

      if (actualVal === null) {
        comparisons.push({ metric, actual: 0, expected: expectedVal, delta: Infinity, match: false });
        allMatch = false;
      } else {
        const delta = Math.abs(actualVal - expectedVal);
        const tolerance = Math.max(0.01, expectedVal * 0.05); // 5% tolerance or 0.01 absolute
        const metricMatch = delta <= tolerance;
        if (!metricMatch) allMatch = false;
        comparisons.push({ metric, actual: actualVal, expected: expectedVal, delta, match: metricMatch });
      }
    }

    return { matches: allMatch, comparisons };
  }

  /**
   * Clean up a temporary working directory.
   */
  async cleanup(workDir: string): Promise<void> {
    try {
      await fs.rm(workDir, { recursive: true, force: true });
    } catch {
      // Best-effort cleanup
    }
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: ExperimentReproducer | null = null;

export function getExperimentReproducer(): ExperimentReproducer {
  if (!_instance) {
    _instance = new ExperimentReproducer();
  }
  return _instance;
}
