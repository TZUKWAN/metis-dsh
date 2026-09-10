/**
 * Main-process experiment attachment persistence with explicit, atomic
 * session/owner access bindings.
 */
import { createHmac } from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import {
  applyExperimentScriptMigration,
  EXPERIMENT_BINDING_SENTINEL,
} from './ExperimentScriptMigration.js';
import type {
  AttachmentAccessBinding,
  ExperimentScriptPersistence,
  MainOnlyExperimentScriptAttachmentRecord,
  MainOnlyExperimentRunRecord,
} from '../runtime/ExperimentRuntimeContract.js';

type Row = Record<string, unknown>;

const BINDING_DIGEST = /^[a-f0-9]{64}$/u;

export interface OwnerIdentity {
  webContentsId: number;
  mainFrameProcessId: number;
  mainFrameRoutingId: number;
}

function isOwnerIdentity(owner: OwnerIdentity): boolean {
  return [owner?.webContentsId, owner?.mainFrameProcessId, owner?.mainFrameRoutingId]
    .every((value) => Number.isSafeInteger(value) && value >= 0);
}

function hmac(context: string, secret: string): string {
  return createHmac('sha256', secret).update(context, 'utf8').digest('hex');
}

export function computeOwnerBinding(owner: OwnerIdentity, secret: string): string {
  if (!isOwnerIdentity(owner) || secret.length < 32) {
    throw new TypeError('Experiment attachment owner binding is unavailable');
  }
  return hmac(
    `owner:${owner.webContentsId}:${owner.mainFrameProcessId}:${owner.mainFrameRoutingId}`,
    secret,
  );
}

export function computeSessionBinding(secret: string): string {
  if (secret.length < 32) throw new TypeError('Experiment process secret must be >= 32 bytes');
  return hmac('session:v1', secret);
}

function isDigest(value: unknown): value is string {
  return typeof value === 'string'
    && BINDING_DIGEST.test(value)
    && value !== EXPERIMENT_BINDING_SENTINEL;
}

export class ExperimentAttachmentRepository implements ExperimentScriptPersistence {
  readonly #db: Database.Database;
  #processSecret = '';
  #sessionBinding = '';

  constructor(db: Database.Database) {
    applyExperimentScriptMigration(db);
    this.#db = db;
  }

  initialize(secret: string): void {
    this.#sessionBinding = computeSessionBinding(secret);
    this.#processSecret = secret;
  }

  get sessionBinding(): string {
    return this.#sessionBinding;
  }

  createAccessBinding(owner: OwnerIdentity): AttachmentAccessBinding {
    if (!isDigest(this.#sessionBinding) || this.#processSecret.length < 32) {
      throw new Error('Experiment attachment repository is not initialized');
    }
    return {
      sessionBinding: this.#sessionBinding,
      ownerBinding: computeOwnerBinding(owner, this.#processSecret),
    };
  }

  computeOwnerBinding(owner: OwnerIdentity): string {
    return this.createAccessBinding(owner).ownerBinding;
  }

  #accepts(binding: AttachmentAccessBinding): boolean {
    return isDigest(this.#sessionBinding)
      && isDigest(binding?.sessionBinding)
      && isDigest(binding?.ownerBinding)
      && binding.sessionBinding === this.#sessionBinding;
  }

  async loadAttachment(
    experimentId: string,
    binding: AttachmentAccessBinding,
  ): Promise<MainOnlyExperimentScriptAttachmentRecord | null> {
    if (!this.#accepts(binding)) return null;
    const row = this.#db.prepare(
      `SELECT experiment_id, attachment_id, display_name, runtime, size_bytes,
              managed_path, content_sha256, attached_at
       FROM experiment_attachments
       WHERE experiment_id = ? AND owner_binding = ? AND session_binding = ?
       ORDER BY attached_at DESC, attachment_id DESC
       LIMIT 1`,
    ).get(experimentId, binding.ownerBinding, binding.sessionBinding) as Row | undefined;
    if (!row) return null;
    return {
      experimentId: row.experiment_id as string,
      attachment: {
        attachmentId: row.attachment_id as string,
        displayName: row.display_name as string,
        runtime: row.runtime as 'python' | 'node',
        sizeBytes: row.size_bytes as number,
        attachedAt: row.attached_at as number,
      },
      managedPath: row.managed_path as string,
      contentSha256: row.content_sha256 as string,
    };
  }

  async saveAttachment(
    record: MainOnlyExperimentScriptAttachmentRecord,
    binding: AttachmentAccessBinding,
  ): Promise<void> {
    if (!this.#accepts(binding)) {
      throw new Error('Experiment attachment access binding is unavailable');
    }
    this.#db.prepare(
      `INSERT INTO experiment_attachments
         (experiment_id, attachment_id, display_name, runtime, size_bytes,
          managed_path, content_sha256, owner_binding, session_binding, attached_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.experimentId,
      record.attachment.attachmentId,
      record.attachment.displayName,
      record.attachment.runtime,
      record.attachment.sizeBytes,
      record.managedPath,
      record.contentSha256,
      binding.ownerBinding,
      binding.sessionBinding,
      record.attachment.attachedAt,
    );
  }

  listReferencedManagedPaths(): string[] {
    return (this.#db.prepare(
      `SELECT DISTINCT managed_path FROM experiment_attachments
       WHERE managed_path IS NOT NULL AND managed_path <> ''`,
    ).all() as Array<{ managed_path: string }>).map((row) => row.managed_path);
  }

  async recordRun(record: MainOnlyExperimentRunRecord): Promise<void> {
    this.#db.prepare(
      `INSERT INTO experiment_runs
         (run_id, experiment_id, attachment_id, status, exit_code, metrics,
          started_at, finished_at, stdout_log_path, stderr_log_path)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      record.runId,
      record.experimentId,
      record.attachmentId,
      record.status,
      record.exitCode,
      JSON.stringify(record.metrics),
      record.startedAt,
      record.finishedAt,
      record.stdoutLogPath,
      record.stderrLogPath,
    );
  }

  getRunsForExperiment(experimentId: string, limit = 50): MainOnlyExperimentRunRecord[] {
    const boundedLimit = Number.isSafeInteger(limit) ? Math.min(Math.max(limit, 1), 1_000) : 50;
    const rows = this.#db.prepare(
      `SELECT run_id, experiment_id, attachment_id, status, exit_code, metrics,
              started_at, finished_at, stdout_log_path, stderr_log_path
       FROM experiment_runs
       WHERE experiment_id = ?
       ORDER BY finished_at DESC
       LIMIT ?`,
    ).all(experimentId, boundedLimit) as Row[];
    return rows.map((row) => ({
      runId: row.run_id as string,
      experimentId: row.experiment_id as string,
      attachmentId: row.attachment_id as string,
      status: row.status as MainOnlyExperimentRunRecord['status'],
      exitCode: row.exit_code as number | null,
      metrics: JSON.parse((row.metrics as string) || '{}') as MainOnlyExperimentRunRecord['metrics'],
      startedAt: row.started_at as number,
      finishedAt: row.finished_at as number,
      stdoutLogPath: row.stdout_log_path as string,
      stderrLogPath: row.stderr_log_path as string,
    }));
  }
}

export interface ExperimentManagedReconcileResult {
  removedTemporaryFiles: number;
  removedOrphanFiles: number;
}

function isWithinRoot(candidate: string, root: string): boolean {
  const relative = path.relative(root, candidate);
  return relative === ''
    || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

function pathKey(value: string): string {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

/**
 * Reconcile managed experiment files without following any symlink. A symlink
 * anywhere below the managed root aborts the pass before that entry is touched.
 */
export function reconcileExperimentManagedRoot(
  managedRoot: string,
  referencedPaths: readonly string[],
): ExperimentManagedReconcileResult {
  fs.mkdirSync(managedRoot, { recursive: true, mode: 0o700 });
  const rootStat = fs.lstatSync(managedRoot);
  if (!rootStat.isDirectory() || rootStat.isSymbolicLink()) {
    throw new Error('Experiment managed root is unavailable');
  }
  const canonicalRoot = fs.realpathSync.native(managedRoot);
  const referenced = new Set(
    referencedPaths
      .filter((value): value is string => typeof value === 'string' && path.isAbsolute(value))
      .map(pathKey),
  );
  const regularFiles: string[] = [];
  const stack = [canonicalRoot];
  while (stack.length > 0) {
    const directory = stack.pop()!;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const candidate = path.join(directory, entry.name);
      const candidateStat = fs.lstatSync(candidate);
      if (candidateStat.isSymbolicLink()) {
        throw new Error('Experiment managed storage contains a symbolic link');
      }
      if (candidateStat.isDirectory()) {
        const canonicalDirectory = fs.realpathSync.native(candidate);
        if (!isWithinRoot(canonicalDirectory, canonicalRoot)) {
          throw new Error('Experiment managed directory escaped its root');
        }
        stack.push(canonicalDirectory);
      } else if (candidateStat.isFile()) {
        regularFiles.push(candidate);
      }
    }
  }

  let removedTemporaryFiles = 0;
  let removedOrphanFiles = 0;
  for (const candidate of regularFiles) {
    const name = path.basename(candidate);
    if (name.startsWith('.attach-') && name.endsWith('.tmp')) {
      fs.unlinkSync(candidate);
      removedTemporaryFiles += 1;
    } else if (!referenced.has(pathKey(candidate))) {
      fs.unlinkSync(candidate);
      removedOrphanFiles += 1;
    }
  }
  return { removedTemporaryFiles, removedOrphanFiles };
}
