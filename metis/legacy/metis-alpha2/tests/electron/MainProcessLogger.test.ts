/**
 * Task 3 tests — MainProcessLogger (DoD: buffered log path, rotation,
 * redaction, shutdown flush, write-failure isolation).
 *
 * Uses real files under a temp dir — the logger's guarantees are about real
 * I/O behavior, so the tests exercise it, not a mock.
 */
import { describe, expect, it, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { MainProcessLogger } from '../../electron/MainProcessLogger';

let tmp: string;

beforeEach(() => {
  tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-logger-'));
});

afterEach(() => {
  fs.rmSync(tmp, { recursive: true, force: true });
});

describe('MainProcessLogger', () => {
  it('buffers console output and flushes it to the tail log', () => {
    const tail = path.join(tmp, 'logs', 'main-app.log');
    const logger = new MainProcessLogger({
      tailLogPath: tail,
      archivePathForDate: () => null,
      flushIntervalMs: 10_000, // no timer flush during the test
    });
    logger.install();
    console.log('buffered-line-one');
    console.warn('buffered-line-two');
    // nothing written yet (buffered)
    expect(fs.existsSync(tail)).toBe(false);
    logger.flushSync();
    const text = fs.readFileSync(tail, 'utf8');
    expect(text).toContain('buffered-line-one');
    expect(text).toContain('buffered-line-two');
    expect(text).toMatch(/\[\d{4}-\d{2}-\d{2}T.*\] \[log\]/);
    logger.dispose();
  });

  it('redacts credential-shaped secrets before writing', () => {
    const tail = path.join(tmp, 'main-app.log');
    const logger = new MainProcessLogger({ tailLogPath: tail, archivePathForDate: () => null });
    logger.install();
    console.log('request with sk-abcdef1234567890 and Authorization: Bearer zzz.yyy.xxx and api_key="super-secret-value" and cookie: session=abc123def');
    logger.flushSync();
    const text = fs.readFileSync(tail, 'utf8');
    expect(text).not.toContain('sk-abcdef1234567890');
    expect(text).not.toContain('zzz.yyy.xxx');
    expect(text).not.toContain('super-secret-value');
    expect(text).not.toContain('session=abc123def');
    expect(text).toContain('sk-***');
    expect(text).toContain('api_key=***');
    logger.dispose();
  });

  it('rotates the tail log when it exceeds the size cap and keeps N rotations', () => {
    const tail = path.join(tmp, 'main-app.log');
    const logger = new MainProcessLogger({
      tailLogPath: tail,
      archivePathForDate: () => null,
      maxTailFileBytes: 1024,
      tailRotationsToKeep: 2,
    });
    logger.install();
    const filler = 'x'.repeat(600);
    for (let i = 0; i < 6; i++) {
      console.log(`${i} ${filler}`);
      logger.flushSync();
    }
    const stats = logger.getStats();
    expect(stats.tailRotations).toBeGreaterThanOrEqual(2);
    expect(fs.existsSync(`${tail}.1`)).toBe(true);
    expect(fs.existsSync(`${tail}.2`)).toBe(true);
    expect(fs.existsSync(`${tail}.3`)).toBe(false);
    logger.dispose();
  });

  it('archives into the data-dir file after rebind, including buffered backlog', () => {
    const archive = path.join(tmp, 'data', 'logs', 'main-2026-09-05.log');
    let dataDir: string | null = null;
    const logger = new MainProcessLogger({
      tailLogPath: null,
      archivePathForDate: () => (dataDir === null ? null : path.join(dataDir, 'logs', 'main-2026-09-05.log')),
    });
    logger.install();
    console.log('before-data-dir-ready');
    logger.flushSync();
    // still buffered (not dropped) while destination is unbound
    expect(fs.existsSync(archive)).toBe(false);
    dataDir = path.join(tmp, 'data');
    logger.rebindArchiveTarget();
    const text = fs.readFileSync(archive, 'utf8');
    expect(text).toContain('before-data-dir-ready');
    logger.dispose();
  });

  it('keeps the app alive when the log destination fails (write failure isolation)', () => {
    // A FILE where the logger needs a DIRECTORY makes mkdirSync fail with ENOTDIR.
    fs.writeFileSync(path.join(tmp, 'blocker'), 'not a directory');
    const logger = new MainProcessLogger({
      tailLogPath: path.join(tmp, 'blocker', 'main-app.log'),
      archivePathForDate: () => path.join(tmp, 'blocker', 'logs', 'x.log'),
    });
    logger.install();
    expect(() => {
      console.log('this must not throw');
      console.error('nor this');
      logger.flushSync();
    }).not.toThrow();
    expect(logger.getStats().failedWrites).toBeGreaterThan(0);
    logger.dispose();
  });

  it('restores the original console on dispose (no double wrap on reinstall)', () => {
    const tail = path.join(tmp, 'main-app.log');
    const original = console.log;
    const logger = new MainProcessLogger({ tailLogPath: tail, archivePathForDate: () => null });
    logger.install();
    logger.install(); // idempotent
    logger.dispose();
    expect(console.log).toBe(original);
  });

  it('supports operationId/correlationId context prefixes', () => {
    const tail = path.join(tmp, 'main-app.log');
    const logger = new MainProcessLogger({ tailLogPath: tail, archivePathForDate: () => null });
    logger.install();
    logger.withContext({ operationId: 'op-42', correlationId: 'run-7' }, () => {
      console.log('scoped message');
    });
    logger.flushSync();
    const text = fs.readFileSync(tail, 'utf8');
    expect(text).toContain('[operationId=op-42 correlationId=run-7] scoped message');
    logger.dispose();
  });
});
