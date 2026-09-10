import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import {
  ExperimentAttachmentRepository,
} from '../../engine/persistence/ExperimentAttachmentRepository.js';
import type {
  AttachmentAccessBinding,
  MainOnlyExperimentRunRecord,
  MainOnlyExperimentScriptAttachmentRecord,
} from '../../engine/runtime/ExperimentRuntimeContract.js';

const SECRET = 'x'.repeat(32);
const OWNER_A = { webContentsId: 1, mainFrameProcessId: 11, mainFrameRoutingId: 111 };
const OWNER_B = { webContentsId: 2, mainFrameProcessId: 22, mainFrameRoutingId: 222 };

function makeAttachment(
  overrides: Partial<MainOnlyExperimentScriptAttachmentRecord> = {},
): MainOnlyExperimentScriptAttachmentRecord {
  return {
    experimentId: 'exp-1',
    attachment: {
      attachmentId: `esa_${'a'.repeat(32)}`,
      displayName: 'test.js',
      runtime: 'node',
      sizeBytes: 100,
      attachedAt: 1,
    },
    managedPath: path.resolve('managed', 'test.js'),
    contentSha256: 'a'.repeat(64),
    ...overrides,
  };
}

function makeRun(
  overrides: Partial<MainOnlyExperimentRunRecord> = {},
): MainOnlyExperimentRunRecord {
  return {
    runId: 'run-1',
    experimentId: 'exp-1',
    attachmentId: `esa_${'a'.repeat(32)}`,
    status: 'completed',
    exitCode: 0,
    metrics: {},
    startedAt: 1,
    finishedAt: 2,
    stdoutLogPath: path.resolve('logs', 'stdout.log'),
    stderrLogPath: path.resolve('logs', 'stderr.log'),
    ...overrides,
  };
}

describe('ExperimentAttachmentRepository', () => {
  let db: Database.Database;
  let repository: ExperimentAttachmentRepository;
  let bindingA: AttachmentAccessBinding;
  let bindingB: AttachmentAccessBinding;

  beforeEach(() => {
    db = new Database(':memory:');
    repository = new ExperimentAttachmentRepository(db);
    repository.initialize(SECRET);
    bindingA = repository.createAccessBinding(OWNER_A);
    bindingB = repository.createAccessBinding(OWNER_B);
  });

  afterEach(() => {
    db.close();
  });

  it('loads null when no attachment exists', async () => {
    await expect(repository.loadAttachment('missing', bindingA)).resolves.toBeNull();
  });

  it('saves and loads an attachment round-trip for the exact binding', async () => {
    const record = makeAttachment();
    await repository.saveAttachment(record, bindingA);
    const loaded = await repository.loadAttachment(record.experimentId, bindingA);
    expect(loaded).toEqual(record);
  });

  it('rejects duplicate attachment insert instead of replacing', async () => {
    const record = makeAttachment();
    await repository.saveAttachment(record, bindingA);
    await expect(repository.saveAttachment(record, bindingA)).rejects.toThrow();
  });

  it('returns the most recent attachment for one exact owner binding', async () => {
    const older = makeAttachment();
    const newer = makeAttachment({
      attachment: {
        ...makeAttachment().attachment,
        attachmentId: `esa_${'b'.repeat(32)}`,
        displayName: 'new.js',
        attachedAt: 2,
      },
      managedPath: path.resolve('managed', 'new.js'),
      contentSha256: 'b'.repeat(64),
    });
    await repository.saveAttachment(older, bindingA);
    await repository.saveAttachment(newer, bindingA);
    expect((await repository.loadAttachment('exp-1', bindingA))?.attachment.attachmentId)
      .toBe(newer.attachment.attachmentId);
  });

  it('records and retrieves a run', async () => {
    await repository.saveAttachment(makeAttachment(), bindingA);
    await repository.recordRun(makeRun());
    expect(repository.getRunsForExperiment('exp-1')).toEqual([makeRun()]);
  });

  it('keeps renderer-safe attachment metadata free of local paths', async () => {
    await repository.saveAttachment(makeAttachment(), bindingA);
    const loaded = await repository.loadAttachment('exp-1', bindingA);
    expect(JSON.stringify(loaded?.attachment)).not.toContain(path.resolve('managed'));
    expect(Object.keys(loaded?.attachment ?? {})).toEqual([
      'attachmentId', 'displayName', 'runtime', 'sizeBytes', 'attachedAt',
    ]);
  });

  it('respects the run query limit', async () => {
    await repository.saveAttachment(makeAttachment(), bindingA);
    for (let index = 1; index <= 3; index += 1) {
      await repository.recordRun(makeRun({ runId: `run-${index}`, finishedAt: index }));
    }
    expect(repository.getRunsForExperiment('exp-1', 2)).toHaveLength(2);
  });

  it('rejects empty, sentinel, cross-owner and cross-session bindings fail-closed', async () => {
    const record = makeAttachment();
    const empty = { sessionBinding: '', ownerBinding: '' };
    const sentinel = { sessionBinding: '0'.repeat(64), ownerBinding: '0'.repeat(64) };
    await expect(repository.saveAttachment(record, empty)).rejects.toThrow();
    await expect(repository.saveAttachment(record, sentinel)).rejects.toThrow();
    await repository.saveAttachment(record, bindingA);
    await expect(repository.loadAttachment('exp-1', bindingB)).resolves.toBeNull();
    const restarted = new ExperimentAttachmentRepository(db);
    restarted.initialize('y'.repeat(32));
    const restartedBinding = restarted.createAccessBinding(OWNER_A);
    await expect(restarted.loadAttachment('exp-1', restartedBinding)).resolves.toBeNull();
  });

  it('passes explicit owner bindings atomically under concurrent saves', async () => {
    const recordA = makeAttachment({ experimentId: 'exp-a' });
    const recordB = makeAttachment({
      experimentId: 'exp-b',
      attachment: { ...makeAttachment().attachment, attachmentId: `esa_${'b'.repeat(32)}` },
    });
    await Promise.all([
      repository.saveAttachment(recordA, bindingA),
      repository.saveAttachment(recordB, bindingB),
    ]);
    await expect(repository.loadAttachment('exp-a', bindingA)).resolves.toEqual(recordA);
    await expect(repository.loadAttachment('exp-b', bindingB)).resolves.toEqual(recordB);
    await expect(repository.loadAttachment('exp-a', bindingB)).resolves.toBeNull();
    await expect(repository.loadAttachment('exp-b', bindingA)).resolves.toBeNull();
  });

  it('stores only HMAC bindings and never the process secret', async () => {
    await repository.saveAttachment(makeAttachment(), bindingA);
    const rows = db.prepare('SELECT * FROM experiment_attachments').all();
    expect(JSON.stringify(rows)).not.toContain(SECRET);
    expect(JSON.stringify(rows)).toContain(bindingA.ownerBinding);
    expect(JSON.stringify(rows)).toContain(bindingA.sessionBinding);
  });
});
