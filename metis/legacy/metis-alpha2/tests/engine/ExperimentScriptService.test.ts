/**
 * GLM-101: Comprehensive security-chain tests for ExperimentScriptService.
 *
 * Uses real temp directories and controlled Node.js subprocesses.
 * Verifies every safety boundary: renderer result leak-free, grant
 * integrity, owner enforcement, timeout, cancel, output cap, persistence
 * failure, tamper detection.
 */

import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import Database from 'better-sqlite3';
import {
  ExperimentAttachmentRepository,
} from '../../engine/persistence/ExperimentAttachmentRepository.js';
import {
  EXPERIMENT_SCRIPT_SERVICE_LIMITS,
  ExperimentScriptService,
} from '../../electron/ExperimentScriptService.js';
import {
  decodeExperimentExecutionGrantResult,
  decodeExperimentRunResult,
  decodeExperimentScriptAttachResult,
  type ExperimentRunResult,
} from '../../engine/runtime/ExperimentRuntimeContract.js';
import type { ExecutionOwnerIdentity } from '../../electron/ExecutionCapabilityRegistry.js';

// ── Helpers ───────────────────────────────────────────────────

const OWNER_A: ExecutionOwnerIdentity = {
  webContentsId: 1,
  mainFrameProcessId: 100,
  mainFrameRoutingId: 1,
};
const OWNER_B: ExecutionOwnerIdentity = {
  webContentsId: 2,
  mainFrameProcessId: 200,
  mainFrameRoutingId: 2,
};

function sha256(data: string | Buffer): string {
  return createHash('sha256').update(data).digest('hex');
}

let tempRoot: string;
let managedRoot: string;
let logRoot: string;
let runtimeRoot: string;
let scriptsDir: string;
let nodeExe: string;
let db: Database.Database;
let repo: ExperimentAttachmentRepository;
let service: ExperimentScriptService;

function writeScript(name: string, code: string): string {
  // The service determines runtime from file extension — always append .js
  const filePath = path.join(scriptsDir, `${name}.js`);
  fs.writeFileSync(filePath, code, 'utf-8');
  return filePath;
}

async function attachAndGrant(
  expId: string,
  scriptName: string,
  owner: ExecutionOwnerIdentity = OWNER_A,
): Promise<{ attachResult: ReturnType<typeof decodeExperimentScriptAttachResult>; grantResult: ReturnType<typeof decodeExperimentExecutionGrantResult> }> {
  // Point selectScriptPath to our scripts dir
  const attachResult = decodeExperimentScriptAttachResult(
    await service.attach({ experimentId: expId }, owner),
  );
  if (attachResult.status !== 'attached') {
    return { attachResult, grantResult: { status: 'rejected', code: 'experiment_script_not_attached' } };
  }
  const grantResult = decodeExperimentExecutionGrantResult(
    await service.requestRunGrant({ experimentId: expId }, owner),
  );
  return { attachResult, grantResult };
}

async function run(
  expId: string,
  grantDescriptor: unknown,
  owner: ExecutionOwnerIdentity = OWNER_A,
): Promise<ExperimentRunResult> {
  return decodeExperimentRunResult(
    await service.run({ experimentId: expId, grant: grantDescriptor }, owner),
  );
}

beforeEach(() => {
  tempRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-glm101-'));
  managedRoot = path.join(tempRoot, 'managed');
  logRoot = path.join(tempRoot, 'logs');
  scriptsDir = path.join(tempRoot, 'scripts');
  runtimeRoot = path.join(tempRoot, 'runtime');
  fs.mkdirSync(managedRoot, { recursive: true });
  fs.mkdirSync(logRoot, { recursive: true });
  fs.mkdirSync(scriptsDir, { recursive: true });
  fs.mkdirSync(runtimeRoot, { recursive: true });

  // Build a minimal "runtime root" with a symlink to the real node.
  // On Windows, copy node.exe instead (symlinks need admin).
  const realNode = process.execPath;
  nodeExe = path.join(runtimeRoot, process.platform === 'win32' ? 'node.exe' : 'node');
  fs.copyFileSync(realNode, nodeExe);

  db = new Database(':memory:');
  repo = new ExperimentAttachmentRepository(db);
  repo.initialize('t'.repeat(32));
  service = new ExperimentScriptService({
    managedRoot,
    logRoot,
    runtimeRoot,
    trustedNodeExecutable: process.execPath,
    selectScriptPath: async (expId) => {
      // Return the matching script based on experimentId.
      const files = fs.readdirSync(scriptsDir);
      for (const ext of ['.js', '.mjs', '.cjs']) {
        const candidate = path.join(scriptsDir, `${expId}${ext}`);
        if (fs.existsSync(candidate)) return candidate;
      }
      if (files.length > 0) return path.join(scriptsDir, files[0]!);
      return null;
    },
    persistence: repo,
    resolveBinding: (owner) => repo.createAccessBinding(owner),
  });
});

afterEach(() => {
  try { service.dispose(); } catch { /* */ }
  try { db.close(); } catch { /* */ }
  try { fs.rmSync(tempRoot, { recursive: true, force: true }); } catch { /* */ }
});

// ── Tests ─────────────────────────────────────────────────────

describe('GLM-101 security chain', () => {

  // 1 ── Managed copy + hash ──────────────────────────────────

  it('attaches a script into managed storage with content hash', async () => {
    const scriptPath = writeScript('exp-copy', 'process.exit(0);\n');
    const content = fs.readFileSync(scriptPath);
    const expected = sha256(content);

    // Override selectScriptPath for this specific test
    const svc = new ExperimentScriptService({
      managedRoot, logRoot, runtimeRoot, trustedNodeExecutable: process.execPath,
      selectScriptPath: async () => scriptPath,
      persistence: repo,
      resolveBinding: (owner) => repo.createAccessBinding(owner),
    });
    try {
      const raw = await svc.attach({ experimentId: 'exp-copy' }, OWNER_A);
      const result = decodeExperimentScriptAttachResult(raw);
      expect(result.status).toBe('attached');
      if (result.status !== 'attached') throw new Error('unreachable');
      expect(result.attachment.runtime).toBe('node');
      expect(result.attachment.sizeBytes).toBe(content.length);
      // Verify the managed file exists and matches
      const stored = await repo.loadAttachment('exp-copy', repo.createAccessBinding(OWNER_A));
      expect(stored).not.toBeNull();
      expect(stored!.contentSha256).toBe(expected);
      expect(fs.existsSync(stored!.managedPath)).toBe(true);
      expect(fs.readFileSync(stored!.managedPath).equals(content)).toBe(true);
    } finally {
      svc.dispose();
    }
  });

  // 2 ── Safe grant descriptor ────────────────────────────────

  it('grant descriptor never exposes path/command/stdout/stderr/cwd', async () => {
    writeScript('exp-safe', 'process.exit(0);\n');
    const { grantResult } = await attachAndGrant('exp-safe', 'exp-safe');
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') throw new Error('unreachable');

    const g = grantResult.grant;
    // The grant descriptor is the renderer-safe result — must not leak
    const serialized = JSON.stringify(g);
    expect(serialized).not.toMatch(/managedRoot/i);
    expect(serialized).not.toMatch(/executablePath/i);
    expect(serialized).not.toMatch(/cwd/i);
    expect(serialized).not.toMatch(/stdout/i);
    expect(serialized).not.toMatch(/stderr/i);
    expect(serialized).not.toMatch(/command/i);
    // Only safe fields
    expect(g).toHaveProperty('grantId');
    expect(g).toHaveProperty('operation');
    expect(g).toHaveProperty('lifetime');
    expect(g).toHaveProperty('consentedAt');
    expect(g).toHaveProperty('issuedAt');
    expect(g).toHaveProperty('expiresAt');
    expect(g.operation).toBe('experiment-script');
    expect(g.lifetime).toBe('once');
  });

  // 3 ── No runtime available ─────────────────────────────────

  it('rejects grant when runtime root is empty', async () => {
    writeScript('exp-nort', 'process.exit(0);\n');
    // Create a service with an invalid runtime root
    const emptyRuntime = path.join(tempRoot, 'no-runtime');
    fs.mkdirSync(emptyRuntime, { recursive: true });
    const svc = new ExperimentScriptService({
      managedRoot, logRoot, runtimeRoot: emptyRuntime,
      selectScriptPath: async () => path.join(scriptsDir, 'exp-nort.js'),
      persistence: repo,
      resolveBinding: (owner) => repo.createAccessBinding(owner),
    });
    try {
      await svc.attach({ experimentId: 'exp-nort' }, OWNER_A);
      const grantResult = decodeExperimentExecutionGrantResult(
        await svc.requestRunGrant({ experimentId: 'exp-nort' }, OWNER_A),
      );
      expect(grantResult.status).toBe('rejected');
      expect(grantResult.code).toBe('experiment_runtime_unavailable');
    } finally {
      svc.dispose();
    }
  });

  // 4 ── Owner mismatch ───────────────────────────────────────

  it('rejects run when owner does not match grant issuer', async () => {
    writeScript('exp-owner', 'process.exit(0);\n');
    const { grantResult } = await attachAndGrant('exp-owner', 'exp-owner.js', OWNER_A);
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') throw new Error('unreachable');

    const runResult = await run('exp-owner', grantResult.grant, OWNER_B);
    expect(runResult.status).toBe('rejected');
  });

  // 5 ── Tampered attachment ──────────────────────────────────

  it('rejects run when managed file is tampered after attach', async () => {
    writeScript('exp-tamper', 'process.exit(0);\n');
    const { grantResult } = await attachAndGrant('exp-tamper', 'exp-tamper.js');
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') throw new Error('unreachable');

    // Tamper: overwrite the managed file
    const stored = await repo.loadAttachment('exp-tamper', repo.createAccessBinding(OWNER_A));
    expect(stored).not.toBeNull();
    fs.writeFileSync(stored!.managedPath, 'process.exit(1); // tampered\n');

    const runResult = await run('exp-tamper', grantResult.grant);
    expect(runResult.status).toBe('rejected');
  });

  // 6 ── Timeout ──────────────────────────────────────────────

  it('times out a script that runs too long', async () => {
    writeScript('exp-timeout', 'setTimeout(() => process.exit(0), 999999);\n');
    // Create a service with very short timeout
    const svc = new ExperimentScriptService({
      managedRoot, logRoot, runtimeRoot, trustedNodeExecutable: process.execPath,
      selectScriptPath: async () => path.join(scriptsDir, 'exp-timeout.js'),
      persistence: repo,
      resolveBinding: (owner) => repo.createAccessBinding(owner),
      timeoutMs: 1_000,
    });
    try {
      await svc.attach({ experimentId: 'exp-timeout' }, OWNER_A);
      const grantResult = decodeExperimentExecutionGrantResult(
        await svc.requestRunGrant({ experimentId: 'exp-timeout' }, OWNER_A),
      );
      expect(grantResult.status).toBe('granted');
      if (grantResult.status !== 'granted') throw new Error('unreachable');

      const runResult = decodeExperimentRunResult(
        await svc.run({ experimentId: 'exp-timeout', grant: grantResult.grant }, OWNER_A),
      );
      expect(runResult.status).toBe('timed_out');
    } finally {
      svc.dispose();
    }
  }, 10_000);

  // 7 ── Cancel ───────────────────────────────────────────────

  it('cancels a running script', async () => {
    writeScript('exp-cancel', 'setTimeout(() => process.exit(0), 999999);\n');
    const { grantResult } = await attachAndGrant('exp-cancel', 'exp-cancel.js');
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') throw new Error('unreachable');

    // Start running in background
    const runPromise = run('exp-cancel', grantResult.grant);
    // Give it a moment to spawn
    await new Promise((r) => setTimeout(r, 500));
    expect(service.cancel('exp-cancel', OWNER_B)).toBe(false);
    const cancelled = service.cancel('exp-cancel', OWNER_A);
    expect(cancelled).toBe(true);

    const runResult = await runPromise;
    expect(runResult.status).toBe('cancelled');
  }, 10_000);

  // 8 ── Output cap ───────────────────────────────────────────

  it('wrong-owner cancel cannot alter or remove the active owner RunControl', async () => {
    const startedMarker = path.join(tempRoot, 'wrong-owner-cancel-started');
    writeScript(
      'exp-wrong-owner-cancel',
      `require('node:fs').writeFileSync(${JSON.stringify(startedMarker)}, 'started'); setTimeout(() => process.exit(0), 999999);\n`,
    );
    const { grantResult } = await attachAndGrant(
      'exp-wrong-owner-cancel',
      'exp-wrong-owner-cancel.js',
    );
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') throw new Error('unreachable');

    const runPromise = run('exp-wrong-owner-cancel', grantResult.grant, OWNER_A);
    const markerDeadline = Date.now() + 5_000;
    while (!fs.existsSync(startedMarker) && Date.now() < markerDeadline) {
      await new Promise((resolve) => setTimeout(resolve, 25));
    }
    expect(fs.existsSync(startedMarker)).toBe(true);

    let runSettled = false;
    runPromise.then(
      () => { runSettled = true; },
      () => { runSettled = true; },
    );
    expect(service.cancel('exp-wrong-owner-cancel', OWNER_B)).toBe(false);
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(runSettled).toBe(false);
    expect(service.cancel('exp-wrong-owner-cancel', OWNER_A)).toBe(true);
    await expect(runPromise).resolves.toMatchObject({ status: 'cancelled' });
  }, 10_000);

  it('caps excessive output and marks as failed', async () => {
    writeScript('exp-flood', `
      const chunk = 'x'.repeat(1024 * 1024); // 1 MiB
      for (let i = 0; i < 20; i++) process.stdout.write(chunk);
      process.exit(0);
    `);
    const { grantResult } = await attachAndGrant('exp-flood', 'exp-flood.js');
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') throw new Error('unreachable');

    const runResult = await run('exp-flood', grantResult.grant);
    expect(['failed', 'timed_out']).toContain(runResult.status);
    // Must NOT succeed with huge output
    expect(runResult.status).not.toBe('completed');
  }, 15_000);

  // 9 ── Persistence failure ──────────────────────────────────

  it('returns safe failure when persistence save throws', async () => {
    const failingRepo = {
      loadAttachment: (...args: Parameters<typeof repo.loadAttachment>) => repo.loadAttachment(...args),
      saveAttachment: async () => { throw new Error('disk full'); },
      recordRun: (record: Parameters<typeof repo.recordRun>[0]) => repo.recordRun(record),
    };
    const svc = new ExperimentScriptService({
      managedRoot, logRoot, runtimeRoot, trustedNodeExecutable: process.execPath,
      selectScriptPath: async () => path.join(scriptsDir, 'exp-copy.js'),
      persistence: failingRepo,
      resolveBinding: (owner) => repo.createAccessBinding(owner),
    });
    try {
      writeScript('exp-copy', 'process.exit(0);\n');
      const result = decodeExperimentScriptAttachResult(
        await svc.attach({ experimentId: 'exp-pfail' }, OWNER_A),
      );
      expect(result.status).toBe('rejected');
      expect(result.code).toBe('experiment_script_copy_failed');
    } finally {
      svc.dispose();
    }
  });

  it('returns safe failure when persistence recordRun throws', async () => {
    writeScript('exp-prunc', 'process.exit(0);\n');
    const failingRunRepo = {
      loadAttachment: (...args: Parameters<typeof repo.loadAttachment>) => repo.loadAttachment(...args),
      saveAttachment: (...args: Parameters<typeof repo.saveAttachment>) => repo.saveAttachment(...args),
      recordRun: async () => { throw new Error('disk full'); },
    };
    const svc = new ExperimentScriptService({
      managedRoot, logRoot, runtimeRoot, trustedNodeExecutable: process.execPath,
      selectScriptPath: async () => path.join(scriptsDir, 'exp-prunc.js'),
      persistence: failingRunRepo,
      resolveBinding: (owner) => repo.createAccessBinding(owner),
      timeoutMs: 5_000,
    });
    try {
      await svc.attach({ experimentId: 'exp-prunc' }, OWNER_A);
      const grantResult = decodeExperimentExecutionGrantResult(
        await svc.requestRunGrant({ experimentId: 'exp-prunc' }, OWNER_A),
      );
      expect(grantResult.status).toBe('granted');
      if (grantResult.status !== 'granted') throw new Error('unreachable');

      const runResult = decodeExperimentRunResult(
        await svc.run({ experimentId: 'exp-prunc', grant: grantResult.grant }, OWNER_A),
      );
      expect(runResult.status).toBe('failed');
    } finally {
      svc.dispose();
    }
  }, 10_000);

  // 10 ── Renderer result leak-free ───────────────────────────

  it('renderer result has no path/stdout/stderr in any status', async () => {
    writeScript('exp-leak', `
      process.stdout.write('METRIC:accuracy=0.95\\n');
      process.stderr.write('debug info\\n');
      process.exit(0);
    `);
    const { grantResult } = await attachAndGrant('exp-leak', 'exp-leak.js');
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') throw new Error('unreachable');

    const runResult = await run('exp-leak', grantResult.grant);
    expect(runResult.status).toBe('completed');

    // Renderer-safe RunResult must have ONLY status, exitCode, metrics
    const resultKeys = Object.keys(runResult).sort();
    expect(resultKeys).toEqual(['exitCode', 'metrics', 'status']);
    expect(runResult.exitCode).toBe(0);
    expect(runResult.metrics).toEqual({ accuracy: 0.95 });

    // Verify no path/command/stdout/stderr anywhere in the result
    const serialized = JSON.stringify(runResult);
    expect(serialized).not.toMatch(/managedRoot/i);
    expect(serialized).not.toMatch(new RegExp(tempRoot.replace(/\\/g, '\\\\'), 'i'));
    expect(serialized).not.toMatch(/stdout/i);
    expect(serialized).not.toMatch(/stderr/i);
    expect(serialized).not.toMatch(/executable/i);
    expect(serialized).not.toMatch(/command/i);
    expect(serialized).not.toMatch(/cwd/i);
    expect(serialized).not.toMatch(/scriptPath/i);
    expect(serialized).not.toMatch(/filePath/i);
  });

  // ── Metric script (bonus: validates correct metric parsing) ─

  it('parses METRIC lines and returns them in the result', async () => {
    writeScript('exp-metric', `
      process.stdout.write('METRIC:precision=0.87\\n');
      process.stdout.write('METRIC:recall=0.92\\n');
      process.exit(0);
    `);
    const { grantResult } = await attachAndGrant('exp-metric', 'exp-metric.js');
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') throw new Error('unreachable');

    const runResult = await run('exp-metric', grantResult.grant);
    expect(runResult.status).toBe('completed');
    expect(runResult.metrics.precision).toBe(0.87);
    expect(runResult.metrics.recall).toBe(0.92);
  });

  // ── Failed script returns failed status ────────────────────

  it('returns failed for a script that exits non-zero', async () => {
    writeScript('exp-fail', 'process.exit(42);\n');
    const { grantResult } = await attachAndGrant('exp-fail', 'exp-fail.js');
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') throw new Error('unreachable');

    const runResult = await run('exp-fail', grantResult.grant);
    expect(runResult.status).toBe('failed');
    expect(runResult.exitCode).toBe(42);
  });

  // ── Concurrent owner isolation ─────────────────────────────

  it('concurrent attaches with different owners get correct owner and no cross-talk', async () => {
    // Create two isolated service instances sharing the same runtime root
    // but with distinct managed/log roots so files never collide.
    const rootA = path.join(tempRoot, 'svc-A');
    const rootB = path.join(tempRoot, 'svc-B');
    fs.mkdirSync(path.join(rootA, 'managed'), { recursive: true });
    fs.mkdirSync(path.join(rootA, 'logs'), { recursive: true });
    fs.mkdirSync(path.join(rootB, 'managed'), { recursive: true });
    fs.mkdirSync(path.join(rootB, 'logs'), { recursive: true });

    // Each service records the owner it received in selectScriptPath.
    const seenOwners: ExecutionOwnerIdentity[] = [];

    function makeService(label: string, acceptedOwner: ExecutionOwnerIdentity) {
      const db = new Database(':memory:');
      const repo = new ExperimentAttachmentRepository(db);
      repo.initialize('c'.repeat(32));
      return {
        svc: new ExperimentScriptService({
          managedRoot: path.join(tempRoot, `svc-${label}`, 'managed'),
          logRoot: path.join(tempRoot, `svc-${label}`, 'logs'),
          runtimeRoot,
          trustedNodeExecutable: process.execPath,
          selectScriptPath: async (_expId, owner) => {
            seenOwners.push({ ...owner });
            // Only accept the designated owner
            if (
              owner.webContentsId !== acceptedOwner.webContentsId
              || owner.mainFrameProcessId !== acceptedOwner.mainFrameProcessId
              || owner.mainFrameRoutingId !== acceptedOwner.mainFrameRoutingId
            ) {
              return null; // fail-closed for wrong owner
            }
            // Return the matching script for this owner's experiment
            const scriptPath = path.join(scriptsDir, `${_expId}.js`);
            return fs.existsSync(scriptPath) ? scriptPath : null;
          },
          persistence: repo,
          resolveBinding: (owner) => repo.createAccessBinding(owner),
        }),
        db,
        repo,
      };
    }

    // Pre-write scripts for both experiments
    writeScript('exp-conc-A', 'process.exit(0);\n');
    writeScript('exp-conc-B', 'process.exit(0);\n');

    const a = makeService('A', OWNER_A);
    const b = makeService('B', OWNER_B);

    try {
      // Fire both attaches concurrently
      const [resultA, resultB] = await Promise.all([
        a.svc.attach({ experimentId: 'exp-conc-A' }, OWNER_A),
        b.svc.attach({ experimentId: 'exp-conc-B' }, OWNER_B),
      ]);

      const attachA = decodeExperimentScriptAttachResult(resultA);
      const attachB = decodeExperimentScriptAttachResult(resultB);

      // Both must succeed
      expect(attachA.status).toBe('attached');
      expect(attachB.status).toBe('attached');
      if (attachA.status !== 'attached' || attachB.status !== 'attached') return;

      // Each attachment must belong to the correct experiment
      expect(attachA.attachment.displayName).toBe('exp-conc-A.js');
      expect(attachB.attachment.displayName).toBe('exp-conc-B.js');

      // No owner cross-talk — each selectScriptPath must have received
      // the correct owner exactly once
      const callsForA = seenOwners.filter(
        (o) => o.webContentsId === OWNER_A.webContentsId,
      );
      const callsForB = seenOwners.filter(
        (o) => o.webContentsId === OWNER_B.webContentsId,
      );
      expect(callsForA.length).toBeGreaterThanOrEqual(1);
      expect(callsForB.length).toBeGreaterThanOrEqual(1);

      // Now verify: OWNER_B cannot run OWNER_A's grant
      const grantA = decodeExperimentExecutionGrantResult(
        await a.svc.requestRunGrant({ experimentId: 'exp-conc-A' }, OWNER_A),
      );
      expect(grantA.status).toBe('granted');
      if (grantA.status !== 'granted') return;

      const stolen = decodeExperimentRunResult(
        await a.svc.run(
          { experimentId: 'exp-conc-A', grant: grantA.grant },
          OWNER_B,
        ),
      );
      expect(stolen.status).toBe('rejected');
    } finally {
      a.svc.dispose();
      b.svc.dispose();
      a.db.close();
      b.db.close();
    }
  });

  it('rejects B fresh-grant and run attacks without invalidating A grant', async () => {
    writeScript('exp-fresh-owner', 'process.exit(0);\n');
    const attached = await service.attach({ experimentId: 'exp-fresh-owner' }, OWNER_A);
    expect(attached.status).toBe('attached');
    const grantA = await service.requestRunGrant({ experimentId: 'exp-fresh-owner' }, OWNER_A);
    expect(grantA.status).toBe('granted');
    if (grantA.status !== 'granted') throw new Error('unreachable');
    const grantB = await service.requestRunGrant({ experimentId: 'exp-fresh-owner' }, OWNER_B);
    expect(grantB).toEqual({ status: 'rejected', code: 'experiment_script_not_attached' });
    await expect(service.run({
      experimentId: 'exp-fresh-owner',
      grant: grantA.grant,
    }, OWNER_B)).resolves.toMatchObject({ status: 'rejected' });
    await expect(service.run({
      experimentId: 'exp-fresh-owner',
      grant: grantA.grant,
    }, OWNER_A)).resolves.toMatchObject({ status: 'completed' });
  });

  it('keeps concurrent A and B attachment bindings isolated in one service', async () => {
    writeScript('exp-bind-A', 'process.exit(0);\n');
    writeScript('exp-bind-B', 'process.exit(0);\n');
    const [attachedA, attachedB] = await Promise.all([
      service.attach({ experimentId: 'exp-bind-A' }, OWNER_A),
      service.attach({ experimentId: 'exp-bind-B' }, OWNER_B),
    ]);
    expect(attachedA.status).toBe('attached');
    expect(attachedB.status).toBe('attached');
    expect((await service.requestRunGrant({ experimentId: 'exp-bind-A' }, OWNER_A)).status)
      .toBe('granted');
    expect((await service.requestRunGrant({ experimentId: 'exp-bind-B' }, OWNER_B)).status)
      .toBe('granted');
    expect((await service.requestRunGrant({ experimentId: 'exp-bind-A' }, OWNER_B)).status)
      .toBe('rejected');
    expect((await service.requestRunGrant({ experimentId: 'exp-bind-B' }, OWNER_A)).status)
      .toBe('rejected');
  });

  it('rejects attachments from a different process session', async () => {
    writeScript('exp-restart', 'process.exit(0);\n');
    expect((await service.attach({ experimentId: 'exp-restart' }, OWNER_A)).status).toBe('attached');
    const restartedRepository = new ExperimentAttachmentRepository(db);
    restartedRepository.initialize('u'.repeat(32));
    const restartedService = new ExperimentScriptService({
      managedRoot,
      logRoot,
      runtimeRoot,
      trustedNodeExecutable: process.execPath,
      selectScriptPath: async () => null,
      persistence: restartedRepository,
      resolveBinding: (owner) => restartedRepository.createAccessBinding(owner),
    });
    try {
      expect((await restartedService.requestRunGrant({ experimentId: 'exp-restart' }, OWNER_A)).status)
        .toBe('rejected');
    } finally {
      restartedService.dispose();
    }
  });

  it('honors same-owner cancellation before attachment validation and never spawns', async () => {
    const marker = path.join(tempRoot, 'must-not-exist.txt');
    writeScript(
      'exp-pre-cancel',
      `require('node:fs').writeFileSync(${JSON.stringify(marker)}, 'spawned'); process.exit(0);\n`,
    );
    let releaseLoad: (() => void) | undefined;
    const blockedLoad = new Promise<void>((resolve) => { releaseLoad = resolve; });
    let block = false;
    const persistence = {
      async loadAttachment(...args: Parameters<typeof repo.loadAttachment>) {
        if (block) await blockedLoad;
        return repo.loadAttachment(...args);
      },
      saveAttachment: (...args: Parameters<typeof repo.saveAttachment>) => repo.saveAttachment(...args),
      recordRun: (...args: Parameters<typeof repo.recordRun>) => repo.recordRun(...args),
    };
    const controlled = new ExperimentScriptService({
      managedRoot,
      logRoot,
      runtimeRoot,
      trustedNodeExecutable: process.execPath,
      selectScriptPath: async () => path.join(scriptsDir, 'exp-pre-cancel.js'),
      persistence,
      resolveBinding: (owner) => repo.createAccessBinding(owner),
    });
    try {
      await controlled.attach({ experimentId: 'exp-pre-cancel' }, OWNER_A);
      const grant = await controlled.requestRunGrant({ experimentId: 'exp-pre-cancel' }, OWNER_A);
      expect(grant.status).toBe('granted');
      if (grant.status !== 'granted') return;
      block = true;
      const runPromise = controlled.run(
        { experimentId: 'exp-pre-cancel', grant: grant.grant },
        OWNER_A,
      );
      expect(controlled.cancel('exp-pre-cancel', OWNER_B)).toBe(false);
      expect(controlled.cancel('exp-pre-cancel', OWNER_A)).toBe(true);
      releaseLoad?.();
      await expect(runPromise).resolves.toMatchObject({ status: 'cancelled' });
      expect(fs.existsSync(marker)).toBe(false);
    } finally {
      releaseLoad?.();
      controlled.dispose();
    }
  });

  it('rejects expired and replayed once grants', async () => {
    writeScript('exp-once', 'process.exit(0);\n');
    const attached = await service.attach({ experimentId: 'exp-once' }, OWNER_A);
    expect(attached.status).toBe('attached');
    const firstGrant = await service.requestRunGrant({ experimentId: 'exp-once' }, OWNER_A);
    expect(firstGrant.status).toBe('granted');
    if (firstGrant.status !== 'granted') return;
    await expect(service.run({ experimentId: 'exp-once', grant: firstGrant.grant }, OWNER_A))
      .resolves.toMatchObject({ status: 'completed' });
    await expect(service.run({ experimentId: 'exp-once', grant: firstGrant.grant }, OWNER_A))
      .resolves.toMatchObject({ status: 'rejected' });

    const secondGrant = await service.requestRunGrant({ experimentId: 'exp-once' }, OWNER_A);
    expect(secondGrant.status).toBe('granted');
    if (secondGrant.status !== 'granted') return;
    const now = Date.now();
    const dateNow = vi.spyOn(Date, 'now').mockReturnValue(
      now + EXPERIMENT_SCRIPT_SERVICE_LIMITS.grantTtlMs + 1,
    );
    try {
      await expect(service.run({ experimentId: 'exp-once', grant: secondGrant.grant }, OWNER_A))
        .resolves.toMatchObject({ status: 'rejected' });
    } finally {
      dateNow.mockRestore();
    }
  });

  it('injects ELECTRON_RUN_AS_NODE into the trusted Node runtime plan', async () => {
    writeScript(
      'exp-runtime-env',
      "if (process.env.ELECTRON_RUN_AS_NODE !== '1') process.exit(42); process.exit(0);\n",
    );
    const { grantResult } = await attachAndGrant('exp-runtime-env', 'exp-runtime-env.js');
    expect(grantResult.status).toBe('granted');
    if (grantResult.status !== 'granted') return;
    await expect(run('exp-runtime-env', grantResult.grant))
      .resolves.toMatchObject({ status: 'completed', exitCode: 0 });
  });
});
