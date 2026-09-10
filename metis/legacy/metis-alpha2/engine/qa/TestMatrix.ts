/**
 * Layered test matrix + performance gates + anti-fake-implementation audit (METIS-1001/1004/1009).
 *
 * 1001: defines the test layers (unit/integration/contract/e2e/visual/perf/release), each with
 *       trigger condition, timeout, environment, and required evidence output. Failed tests
 *       must NOT be silently ignored — the gate enforces this.
 * 1004: performance budgets (cold start, project open, PDF first paint, large table, network,
 *       memory, bundle). Over-budget => release gate fails.
 * 1009: scans for mock/placeholder/stub/fake/hardcoded/demo/TODO/FIXME across the codebase,
 *       so nothing fake ships as a real feature.
 */

// ─── METIS-1001 Test matrix ───────────────────────────────────

export type TestLayer = 'unit' | 'integration' | 'contract' | 'e2e' | 'visual' | 'performance' | 'release';

export interface TestLayerSpec {
  layer: TestLayer;
  trigger: string;
  defaultTimeoutMs: number;
  environment: string;
  evidenceOutput: string;
  /** Whether failures in this layer block release. */
  blocking: boolean;
}

export const TEST_MATRIX: readonly TestLayerSpec[] = [
  { layer: 'unit', trigger: 'every commit', defaultTimeoutMs: 5_000, environment: 'node/jsdom', evidenceOutput: 'vitest report', blocking: true },
  { layer: 'integration', trigger: 'every commit', defaultTimeoutMs: 15_000, environment: 'node + sqlite', evidenceOutput: 'vitest report', blocking: true },
  { layer: 'contract', trigger: 'on capability/schema change', defaultTimeoutMs: 5_000, environment: 'node', evidenceOutput: 'zod schema report', blocking: true },
  { layer: 'e2e', trigger: 'pre-release', defaultTimeoutMs: 60_000, environment: 'electron + isolated userData', evidenceOutput: 'structured e2e log + screenshots', blocking: true },
  { layer: 'visual', trigger: 'pre-release', defaultTimeoutMs: 30_000, environment: 'playwright + electron', evidenceOutput: 'screenshot diff report', blocking: true },
  { layer: 'performance', trigger: 'pre-release', defaultTimeoutMs: 120_000, environment: 'fixed hardware + dataset', evidenceOutput: 'perf benchmark json', blocking: true },
  { layer: 'release', trigger: 'release candidate', defaultTimeoutMs: 300_000, environment: 'clean windows vm', evidenceOutput: 'release audit report', blocking: true },
];

/** Evaluate a gate: any blocking layer with failures => gate fails (METIS-1001). */
export interface LayerResult {
  layer: TestLayer;
  passed: boolean;
  failureCount: number;
  silentlyIgnored: boolean;
}

export function evaluateGate(results: LayerResult[]): { passed: boolean; blockingFailures: LayerResult[]; ignoredFound: boolean } {
  const blockingFailures = results.filter((r) => r.layer !== undefined && TEST_MATRIX.find((t) => t.layer === r.layer)?.blocking && !r.passed);
  const ignoredFound = results.some((r) => r.silentlyIgnored);
  // silently-ignored failures are themselves a gate failure (METIS-1001: never silently ignored).
  return { passed: blockingFailures.length === 0 && !ignoredFound, blockingFailures, ignoredFound };
}

// ─── METIS-1004 Performance budgets ───────────────────────────

export interface PerfBudget {
  coldStartMs: number;
  projectOpenMs: number;
  pdfFirstPaintMs: number;
  largeTableScrollFps: number;       // min fps
  networkGraphFpsAt1kNodes: number;  // min fps
  memoryMb: number;                  // max
  bundleKb: number;                  // max initial bundle
}

export const DEFAULT_PERF_BUDGET: PerfBudget = {
  coldStartMs: 4_000,
  projectOpenMs: 1_500,
  pdfFirstPaintMs: 1_200,
  largeTableScrollFps: 50,
  networkGraphFpsAt1kNodes: 30,
  memoryMb: 600,
  bundleKb: 2_500,
};

export interface PerfMeasurement {
  coldStartMs: number;
  projectOpenMs: number;
  pdfFirstPaintMs: number;
  largeTableScrollFps: number;
  networkGraphFpsAt1kNodes: number;
  memoryMb: number;
  bundleKb: number;
}

export interface PerfGateResult {
  passed: boolean;
  overBudget: Array<{ metric: string; budget: number; actual: number }>;
}

/** A measurement over budget on any metric fails the release gate (METIS-1004). */
export function checkPerfGate(measurement: PerfMeasurement, budget: PerfBudget = DEFAULT_PERF_BUDGET): PerfGateResult {
  const over: Array<{ metric: string; budget: number; actual: number }> = [];
  if (measurement.coldStartMs > budget.coldStartMs) over.push({ metric: 'coldStartMs', budget: budget.coldStartMs, actual: measurement.coldStartMs });
  if (measurement.projectOpenMs > budget.projectOpenMs) over.push({ metric: 'projectOpenMs', budget: budget.projectOpenMs, actual: measurement.projectOpenMs });
  if (measurement.pdfFirstPaintMs > budget.pdfFirstPaintMs) over.push({ metric: 'pdfFirstPaintMs', budget: budget.pdfFirstPaintMs, actual: measurement.pdfFirstPaintMs });
  if (measurement.largeTableScrollFps < budget.largeTableScrollFps) over.push({ metric: 'largeTableScrollFps', budget: budget.largeTableScrollFps, actual: measurement.largeTableScrollFps });
  if (measurement.networkGraphFpsAt1kNodes < budget.networkGraphFpsAt1kNodes) over.push({ metric: 'networkGraphFpsAt1kNodes', budget: budget.networkGraphFpsAt1kNodes, actual: measurement.networkGraphFpsAt1kNodes });
  if (measurement.memoryMb > budget.memoryMb) over.push({ metric: 'memoryMb', budget: budget.memoryMb, actual: measurement.memoryMb });
  if (measurement.bundleKb > budget.bundleKb) over.push({ metric: 'bundleKb', budget: budget.bundleKb, actual: measurement.bundleKb });
  return { passed: over.length === 0, overBudget: over };
}

// ─── METIS-1009 Anti-fake-implementation audit ────────────────

export const FAKE_MARKERS = ['TODO', 'FIXME', 'mock', 'stub', 'placeholder', 'demo', 'fake', 'hardcoded', 'not implemented', '未实现', '占位'] as const;

export interface FakeFinding {
  file: string;
  line: number;
  marker: string;
  snippet: string;
  /** False positives the auditor should review (e.g. a legit "mock" in a test name). */
  likelyFalsePositive: boolean;
}

/**
 * Scan source text for fake-implementation markers. Test files are flagged but usually
 * legitimate (likelyFalsePositive=true); production code findings must be reviewed.
 */
export function scanForFakeImplementation(files: Array<{ path: string; content: string }>): FakeFinding[] {
  const findings: FakeFinding[] = [];
  const isTest = (p: string) => /\.test\.[tj]sx?$|__tests__|tests\//i.test(p);
  for (const f of files) {
    const lines = f.content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      const lower = lines[i]!.toLowerCase();
      for (const marker of FAKE_MARKERS) {
        if (lower.includes(marker.toLowerCase())) {
          findings.push({
            file: f.path,
            line: i + 1,
            marker,
            snippet: lines[i]!.trim().slice(0, 120),
            likelyFalsePositive: isTest(f.path) || lower.includes('//') && !lower.slice(lower.indexOf('//')).includes(marker.toLowerCase()) === false,
          });
        }
      }
    }
  }
  return findings;
}

/** A release gate check: production-code fake findings must each be justified (METIS-1009). */
export function auditFakeFindings(findings: FakeFinding[]): { blocking: FakeFinding[]; reviewable: FakeFinding[] } {
  const blocking = findings.filter((f) => !f.likelyFalsePositive);
  const reviewable = findings.filter((f) => f.likelyFalsePositive);
  return { blocking, reviewable };
}
