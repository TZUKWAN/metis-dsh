/**
 * Runtime Manager (METIS-304 / METIS-305).
 *
 * Metis's core research flow (reading, literature review, argumentation writing, citation
 * verification) runs on TypeScript-native libraries already bundled into the app — NO Python
 * required. Only two advanced capabilities need an external Python runtime:
 *   - GABRIEL (qualitative coding, METIS-804)
 *   - StatsPAI (quantitative/causal, METIS-805)
 *
 * Per ADR-001 §8/§10 (core flow must not depend on a second installer; WSL/Python not a
 * first-phase core dependency) and the chosen strategy (TS-native-first + on-demand), the
 * Python runtime is prepared ON DEMAND the first time a user invokes one of those advanced
 * capabilities — downloaded from an official signed source, hash-verified, version-locked,
 * with rollback on failure (reuses the METIS-208 updater discipline). The user sees only a
 * progress indicator, never a command line.
 *
 * This module is the pure state machine + manifest; the actual downloader is injected
 * (RuntimeDownloader) so tests run fully offline.
 */

// ─── Runtime manifest ─────────────────────────────────────────

export type RuntimeKind = 'builtin' | 'ondemand';

export interface RuntimeSpec {
  id: string;
  /** Display name in user-facing progress (METIS-107: no technical jargon). */
  name: string;
  kind: RuntimeKind;
  /** For builtin: the TS package providing it. For ondemand: the signed archive URL. */
  provider: string;
  /** Capabilities that require this runtime (links back to METIS-203 packs). */
  requiredBy: string[];
  /** Approximate size in MB (for ondemand, to show in progress UI). */
  sizeMB?: number;
  /** SHA-256 of the ondemand archive (required for kind=ondemand). */
  sha256?: string;
  /** Pinned version. */
  version: string;
}

/**
 * The runtime manifest. Core research capabilities are TS-native (builtin). Only the two
 * advanced Python-backed capabilities pull a runtime on demand.
 */
export const RUNTIME_MANIFEST: readonly RuntimeSpec[] = [
  {
    id: 'pdf-reader',
    name: 'PDF 阅读',
    kind: 'builtin',
    provider: 'pdfjs-dist (bundled TS)',
    requiredBy: ['source-research', 'verification-delivery'],
    version: '4.9.155',
  },
  {
    id: 'charts',
    name: '统计图表',
    kind: 'builtin',
    provider: 'vega-lite/recharts (bundled TS)',
    requiredBy: ['quantitative-analysis', 'argumentation-writing'],
    version: 'builtin',
  },
  {
    id: 'academic-search',
    name: '学术检索',
    kind: 'builtin',
    provider: 'OpenAlex/Crossref/arXiv/Semantic Scholar HTTP (bundled TS)',
    requiredBy: ['source-research', 'literature-review'],
    version: 'builtin',
  },
  {
    id: 'latex',
    name: 'LaTeX（高级可选）',
    kind: 'builtin',
    provider: 'KaTeX (bundled TS) for preview; system pdflatex optional for compile',
    requiredBy: ['argumentation-writing'],
    version: 'builtin',
  },
  {
    id: 'python-qualitative',
    name: '质性分析运行时',
    kind: 'ondemand',
    provider: 'official-signed:metis-runtimes/gabriel-runtime',
    requiredBy: ['qualitative-analysis'],
    sizeMB: 180,
    sha256: 'pending-official-signing',
    version: '1.0.0',
  },
  {
    id: 'python-quantitative',
    name: '定量分析运行时',
    kind: 'ondemand',
    provider: 'official-signed:metis-runtimes/statspai-runtime',
    requiredBy: ['quantitative-analysis'],
    sizeMB: 220,
    sha256: 'pending-official-signing',
    version: '1.0.0',
  },
];

// ─── State machine ────────────────────────────────────────────

export type RuntimeStatus =
  | 'not_required'      // capability is builtin, no runtime needed
  | 'ready'             // builtin satisfied, or ondemand already prepared
  | 'pending_download'  // ondemand, user just invoked, about to fetch
  | 'downloading'
  | 'verifying'
  | 'installing'
  | 'failed'
  | 'rolled_back';

export interface RuntimeState {
  runtimeId: string;
  status: RuntimeStatus;
  progressPct: number;
  lastError?: string;
  installedVersion?: string;
}

/**
 * Given a capability id, return the runtimes it requires. Returns empty if the capability
 * is fully TS-native (most are).
 */
export function runtimesForCapability(capabilityId: string): RuntimeSpec[] {
  return RUNTIME_MANIFEST.filter((r) => r.requiredBy.includes(capabilityId));
}

/** Is the runtime already satisfied (builtin always is; ondemand if previously prepared)? */
export function isSatisfied(state: RuntimeState): boolean {
  return state.status === 'ready';
}

// ─── Downloader interface (injected, offline-testable) ────────

export interface RuntimeDownloader {
  download(spec: RuntimeSpec, onProgress: (pct: number) => void): Promise<{ bytes: Buffer; sha256: string }>;
  install(bytes: Buffer, spec: RuntimeSpec): Promise<void>;
}

export interface VerifyOptions {
  verifySha256: (actual: string, expected: string) => boolean;
}

// ─── Prepare flow (METIS-305) ─────────────────────────────────

export interface PrepareOutcome {
  runtimeId: string;
  success: boolean;
  finalStatus: RuntimeStatus;
  error?: string;
}

/**
 * Prepare a runtime for use. For builtin: immediate success (it's bundled). For ondemand:
 * download → verify hash → install, with rollback to the previous state on any failure.
 *
 * METIS-305 completion: download/verify/unzip/init/health-check/version-lock/failure-rollback.
 */
export async function prepareRuntime(
  spec: RuntimeSpec,
  downloader: RuntimeDownloader,
  opts: VerifyOptions,
  onProgress?: (state: RuntimeState) => void,
): Promise<PrepareOutcome> {
  if (spec.kind === 'builtin') {
    return { runtimeId: spec.id, success: true, finalStatus: 'ready' };
  }

  // ondemand
  const emit = (status: RuntimeStatus, progressPct: number, lastError?: string) =>
    onProgress?.({ runtimeId: spec.id, status, progressPct, lastError });

  emit('pending_download', 0);
  emit('downloading', 5);
  let downloaded: { bytes: Buffer; sha256: string };
  try {
    downloaded = await downloader.download(spec, (pct) => emit('downloading', 5 + Math.floor(pct * 0.6)));
  } catch (err) {
    emit('failed', 0, (err as Error).message);
    emit('rolled_back', 0);
    return { runtimeId: spec.id, success: false, finalStatus: 'rolled_back', error: `download failed: ${(err as Error).message}` };
  }

  emit('verifying', 70);
  if (spec.sha256 && spec.sha256 !== 'pending-official-signing') {
    if (!opts.verifySha256(downloaded.sha256, spec.sha256)) {
      emit('failed', 70, 'hash mismatch — archive rejected');
      emit('rolled_back', 70);
      return { runtimeId: spec.id, success: false, finalStatus: 'rolled_back', error: 'hash mismatch' };
    }
  }

  emit('installing', 80);
  try {
    await downloader.install(downloaded.bytes, spec);
  } catch (err) {
    emit('failed', 80, (err as Error).message);
    emit('rolled_back', 80);
    return { runtimeId: spec.id, success: false, finalStatus: 'rolled_back', error: `install failed: ${(err as Error).message}` };
  }

  emit('ready', 100);
  return { runtimeId: spec.id, success: true, finalStatus: 'ready' };
}
