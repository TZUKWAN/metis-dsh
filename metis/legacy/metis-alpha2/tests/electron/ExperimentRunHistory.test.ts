/**
 * Tests for experiment run history and output retrieval.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import Database from 'better-sqlite3';
import { ExperimentAttachmentRepository } from '../../engine/persistence/ExperimentAttachmentRepository.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-exp-run-history-'));
}

const OWNER = { webContentsId: 1, mainFrameProcessId: 2, mainFrameRoutingId: 3 };

describe('experiment run history', () => {
  let dir: string;
  let db: Database.Database;
  let repository: ExperimentAttachmentRepository;

  beforeEach(() => {
    dir = tempDir();
    db = new Database(path.join(dir, 'test.db'));
    repository = new ExperimentAttachmentRepository(db);
    repository.initialize('test-secret-for-experiment-runs-at-least-32-bytes-long');
  });

  afterEach(() => {
    db.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  async function seedAttachment(): Promise<void> {
    const binding = repository.createAccessBinding(OWNER);
    await repository.saveAttachment({
      experimentId: 'exp-1',
      attachment: {
        attachmentId: 'att-1',
        displayName: 'script.py',
        runtime: 'python',
        sizeBytes: 100,
        attachedAt: 1500,
      },
      managedPath: '/tmp/script.py',
      contentSha256: 'abc123',
    }, binding);
  }

  it('records and lists runs with sanitized fields', async () => {
    await seedAttachment();
    const stdoutLogPath = path.join(dir, 'stdout.log');
    fs.writeFileSync(stdoutLogPath, 'experiment output line 1\nexperiment output line 2');
    await repository.recordRun({
      runId: 'run-1',
      experimentId: 'exp-1',
      attachmentId: 'att-1',
      status: 'completed',
      exitCode: 0,
      metrics: { accuracy: 0.95 },
      startedAt: 1000,
      finishedAt: 2000,
      stdoutLogPath,
      stderrLogPath: '',
    });

    const runs = repository.getRunsForExperiment('exp-1');
    expect(runs).toHaveLength(1);
    expect(runs[0]!.runId).toBe('run-1');
    expect(runs[0]!.status).toBe('completed');
    expect(runs[0]!.stdoutLogPath).toBe(stdoutLogPath);
  });

  it('returns empty for unknown experiment', () => {
    expect(repository.getRunsForExperiment('nonexistent')).toEqual([]);
  });

  it('respects the limit parameter', async () => {
    await seedAttachment();
    for (let i = 0; i < 5; i++) {
      await repository.recordRun({
        runId: `run-${i}`,
        experimentId: 'exp-1',
        attachmentId: 'att-1',
        status: 'completed',
        exitCode: 0,
        metrics: {},
        startedAt: 1000 + i,
        finishedAt: 2000 + i,
        stdoutLogPath: '',
        stderrLogPath: '',
      });
    }
    const runs = repository.getRunsForExperiment('exp-1', 3);
    expect(runs).toHaveLength(3);
    expect(runs[0]!.runId).toBe('run-4');
  });
});
