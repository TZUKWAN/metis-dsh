/**
 * METIS-304/305 — Runtime Manager tests.
 *
 * Covers: builtin runtimes are immediately ready (no Python for core flow); ondemand
 * prepare happy path with progress; download failure → rollback; hash mismatch → reject +
 * rollback; install failure → rollback; core capabilities don't require any ondemand runtime.
 */

import { describe, it, expect } from 'vitest';
import {
  RUNTIME_MANIFEST,
  runtimesForCapability,
  prepareRuntime,
  type RuntimeDownloader,
  type RuntimeState,
  type VerifyOptions,
} from './RuntimeManager.js';

function makeDownloader(over: Partial<{
  downloadResult: { bytes: Buffer; sha256: string };
  downloadThrows?: Error;
  installThrows?: Error;
}>): RuntimeDownloader {
  const result = over.downloadResult ?? { bytes: Buffer.from('archive'), sha256: 'expected-hash' };
  return {
    async download(_spec, onProgress) {
      if (over.downloadThrows) throw over.downloadThrows;
      onProgress(50);
      onProgress(100);
      return result;
    },
    async install() {
      if (over.installThrows) throw over.installThrows;
    },
  };
}

const OK_VERIFY: VerifyOptions = { verifySha256: () => true };
const BAD_VERIFY: VerifyOptions = { verifySha256: () => false };

describe('METIS-304 RuntimeManager — core flow is TS-native (no Python required)', () => {
  it('reading/literature-review/writing capabilities have only builtin runtimes', () => {
    for (const capId of ['source-research', 'literature-review', 'argumentation-writing', 'verification-delivery']) {
      const ondemand = runtimesForCapability(capId).filter((r) => r.kind === 'ondemand');
      expect(ondemand, `${capId} must not require ondemand runtime for core flow`).toHaveLength(0);
    }
  });

  it('only qualitative/quantitative capabilities require an ondemand runtime', () => {
    const ondemandCaps = new Set<string>();
    for (const r of RUNTIME_MANIFEST) {
      if (r.kind === 'ondemand') for (const c of r.requiredBy) ondemandCaps.add(c);
    }
    expect([...ondemandCaps].sort()).toEqual(['qualitative-analysis', 'quantitative-analysis']);
  });
});

describe('METIS-304/305 RuntimeManager — builtin prepare is immediate', () => {
  it('returns ready instantly for builtin specs', async () => {
    const builtin = RUNTIME_MANIFEST.find((r) => r.kind === 'builtin')!;
    const outcome = await prepareRuntime(builtin, makeDownloader({}), OK_VERIFY);
    expect(outcome.success).toBe(true);
    expect(outcome.finalStatus).toBe('ready');
  });
});

describe('METIS-305 RuntimeManager — ondemand prepare happy path', () => {
  it('downloads, verifies, installs, and reports ready with progress', async () => {
    const spec = RUNTIME_MANIFEST.find((r) => r.id === 'python-qualitative')!;
    const states: RuntimeState[] = [];
    const outcome = await prepareRuntime(spec, makeDownloader({}), OK_VERIFY, (s) => states.push(s));
    expect(outcome.success).toBe(true);
    expect(outcome.finalStatus).toBe('ready');
    // progress was reported across phases
    const statuses = states.map((s) => s.status);
    expect(statuses).toContain('downloading');
    expect(statuses).toContain('verifying');
    expect(statuses).toContain('installing');
    expect(statuses).toContain('ready');
    const last = states[states.length - 1]!;
    expect(last.progressPct).toBe(100);
  });
});

describe('METIS-305 RuntimeManager — failure → rollback', () => {
  it('download failure rolls back (network/interrupted)', async () => {
    const spec = RUNTIME_MANIFEST.find((r) => r.id === 'python-quantitative')!;
    const states: RuntimeState[] = [];
    const outcome = await prepareRuntime(spec, makeDownloader({ downloadThrows: new Error('ENOTFOUND offline') }), OK_VERIFY, (s) => states.push(s));
    expect(outcome.success).toBe(false);
    expect(outcome.finalStatus).toBe('rolled_back');
    expect(outcome.error).toMatch(/download failed/i);
    expect(states.map((s) => s.status)).toContain('rolled_back');
  });

  it('hash mismatch rejects + rolls back (corrupt/tampered archive)', async () => {
    const spec = RUNTIME_MANIFEST.find((r) => r.id === 'python-qualitative')!;
    // give the spec a real expected hash so the verify branch triggers
    const specWithHash = { ...spec, sha256: 'official-hash-abc' };
    const outcome = await prepareRuntime(specWithHash, makeDownloader({ downloadResult: { bytes: Buffer.from('x'), sha256: 'wrong' } }), BAD_VERIFY);
    expect(outcome.success).toBe(false);
    expect(outcome.finalStatus).toBe('rolled_back');
    expect(outcome.error).toMatch(/hash mismatch/i);
  });

  it('install failure rolls back (disk full / corrupt)', async () => {
    const spec = RUNTIME_MANIFEST.find((r) => r.id === 'python-quantitative')!;
    const outcome = await prepareRuntime(spec, makeDownloader({ installThrows: new Error('ENOSPC disk full') }), OK_VERIFY);
    expect(outcome.success).toBe(false);
    expect(outcome.finalStatus).toBe('rolled_back');
    expect(outcome.error).toMatch(/install failed/i);
  });
});
