import path from 'node:path';
import Database from 'better-sqlite3';
import { afterEach, describe, expect, it } from 'vitest';
import { ExperimentAttachmentRepository } from '../../engine/persistence/ExperimentAttachmentRepository.js';
import {
  applyExperimentScriptMigration,
  EXPERIMENT_SCRIPT_SCHEMA_VERSION,
} from '../../engine/persistence/ExperimentScriptMigration.js';

const LEGACY_ATTACHMENTS = `CREATE TABLE experiment_attachments (
  experiment_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  display_name TEXT NOT NULL,
  runtime TEXT NOT NULL,
  size_bytes INTEGER NOT NULL,
  managed_path TEXT NOT NULL,
  content_sha256 TEXT NOT NULL,
  session_secret TEXT NOT NULL DEFAULT '',
  attached_at INTEGER NOT NULL,
  PRIMARY KEY (experiment_id, attachment_id)
) WITHOUT ROWID;`;

const LEGACY_RUNS = `CREATE TABLE experiment_runs (
  run_id TEXT PRIMARY KEY,
  experiment_id TEXT NOT NULL,
  attachment_id TEXT NOT NULL,
  status TEXT NOT NULL,
  exit_code INTEGER,
  metrics TEXT NOT NULL DEFAULT '{}',
  started_at INTEGER NOT NULL,
  finished_at INTEGER NOT NULL,
  stdout_log_path TEXT NOT NULL,
  stderr_log_path TEXT NOT NULL
) WITHOUT ROWID;`;

describe('ExperimentScriptMigration', () => {
  const databases: Database.Database[] = [];
  afterEach(() => {
    for (const db of databases.splice(0)) db.close();
  });

  it('upgrades a legacy table once, rejects old rows, and accepts new bound rows', async () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(`${LEGACY_ATTACHMENTS}${LEGACY_RUNS}`);
    db.prepare(
      `INSERT INTO experiment_attachments
         (experiment_id, attachment_id, display_name, runtime, size_bytes,
          managed_path, content_sha256, session_secret, attached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      'legacy',
      `esa_${'l'.repeat(32)}`,
      'legacy.js',
      'node',
      1,
      path.resolve('legacy.js'),
      'a'.repeat(64),
      'legacy-plaintext-secret',
      1,
    );

    applyExperimentScriptMigration(db);
    applyExperimentScriptMigration(db);
    const attachmentColumns = (db.pragma('table_info(experiment_attachments)') as Array<{ name: string }>)
      .map((row) => row.name);
    const runColumns = (db.pragma('table_info(experiment_runs)') as Array<{ name: string }>)
      .map((row) => row.name);
    expect(attachmentColumns).toContain('owner_binding');
    expect(attachmentColumns).toContain('session_binding');
    expect(runColumns).toContain('cancel_owner_binding');
    expect(db.prepare('SELECT version FROM experiment_script_migrations').all())
      .toEqual([{ version: EXPERIMENT_SCRIPT_SCHEMA_VERSION }]);

    const processSecret = 'R3-process-secret-do-not-persist-1234567890';
    const repository = new ExperimentAttachmentRepository(db);
    repository.initialize(processSecret);
    const binding = repository.createAccessBinding({
      webContentsId: 1,
      mainFrameProcessId: 2,
      mainFrameRoutingId: 3,
    });
    await expect(repository.loadAttachment('legacy', binding)).resolves.toBeNull();
    await repository.saveAttachment({
      experimentId: 'fresh',
      attachment: {
        attachmentId: `esa_${'n'.repeat(32)}`,
        displayName: 'fresh.js',
        runtime: 'node',
        sizeBytes: 1,
        attachedAt: 2,
      },
      managedPath: path.resolve('fresh.js'),
      contentSha256: 'b'.repeat(64),
    }, binding);
    await expect(repository.loadAttachment('fresh', binding)).resolves.not.toBeNull();
    expect(JSON.stringify(db.prepare('SELECT * FROM experiment_attachments').all()))
      .not.toContain(processSecret);
  });

  it('rolls back structural changes when a later migration statement fails', () => {
    const db = new Database(':memory:');
    databases.push(db);
    db.exec(`${LEGACY_ATTACHMENTS}
      CREATE TABLE experiment_runs (run_id TEXT PRIMARY KEY) WITHOUT ROWID;`);
    expect(() => applyExperimentScriptMigration(db)).toThrow();
    const runColumns = (db.pragma('table_info(experiment_runs)') as Array<{ name: string }>)
      .map((row) => row.name);
    expect(runColumns).not.toContain('cancel_owner_binding');
    const migrationTable = db.prepare(
      "SELECT name FROM sqlite_master WHERE type='table' AND name='experiment_script_migrations'",
    ).get();
    expect(migrationTable).toBeUndefined();
  });
});
