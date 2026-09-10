/**
 * Durable Submission Package persistence — 投稿预检 + 投稿包 SQLite repository（P2）。
 *
 * 风格与 SubmissionRepository / JournalProfileRepository 一致：单类持有
 * better-sqlite3 句柄、动词命名方法、行→camelCase 私有映射、事务化写入、
 * 写入前对可选字符串字段做 `?? ''` 防御。
 *
 * 硬边界：
 *  - 预检 run + checks 单事务落库（要么全落要么全回滚），append-only；
 *  - package frozen 后 addPackageFile / updatePackageFile / removePackageFile
 *    一律抛 submission_package_frozen，冻结后的材料清单不可再改。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  SubmissionPackageFileSchema,
  SubmissionPackageSchema,
  SubmissionPreflightCheckSchema,
  SubmissionPreflightRunSchema,
  type SubmissionPackage,
  type SubmissionPackageFile,
  type SubmissionPackageFileCreateInput,
  type SubmissionPackageFilePatch,
  type SubmissionPackageFileType,
  type SubmissionPackageFileValidationStatus,
  type SubmissionPackageStatus,
  type SubmissionPreflightCheck,
  type SubmissionPreflightCheckCreateInput,
  type SubmissionPreflightCheckKey,
  type SubmissionPreflightCheckLevel,
  type SubmissionPreflightCheckSource,
  type SubmissionPreflightRun,
} from '../engine/submission/SubmissionPackageContract.js';

type RunRow = {
  id: string; case_id: string; outcome_id: string; outcome_version: number;
  passed: number; block_count: number; warn_count: number; created_at: number;
};
type CheckRow = {
  id: string; run_id: string; case_id: string; check_key: string; label: string;
  level: string; detail: string; source: string; created_at: number;
};
type PackageRow = {
  id: string; case_id: string; status: string; round: number;
  created_at: number; updated_at: number; frozen_at: number | null;
};
type PackageFileRow = {
  id: string; package_id: string; type: string; filename: string;
  outcome_id: string | null; outcome_version: number | null; artifact_path: string | null;
  content_hash: string; required: number; validation_status: string; note: string;
  created_at: number; updated_at: number;
};

const asRun = (row: RunRow): SubmissionPreflightRun => SubmissionPreflightRunSchema.parse({
  id: row.id,
  caseId: row.case_id,
  outcomeId: row.outcome_id,
  outcomeVersion: row.outcome_version,
  passed: row.passed === 1,
  blockCount: row.block_count,
  warnCount: row.warn_count,
  createdAt: row.created_at,
});
const asCheck = (row: CheckRow): SubmissionPreflightCheck => SubmissionPreflightCheckSchema.parse({
  id: row.id,
  caseId: row.case_id,
  runId: row.run_id,
  checkKey: row.check_key as SubmissionPreflightCheckKey,
  label: row.label,
  level: row.level as SubmissionPreflightCheckLevel,
  detail: row.detail,
  source: row.source as SubmissionPreflightCheckSource,
  createdAt: row.created_at,
});
const asPackage = (row: PackageRow): SubmissionPackage => SubmissionPackageSchema.parse({
  id: row.id,
  caseId: row.case_id,
  status: row.status as SubmissionPackageStatus,
  round: row.round,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
  frozenAt: row.frozen_at,
});
const asPackageFile = (row: PackageFileRow): SubmissionPackageFile => SubmissionPackageFileSchema.parse({
  id: row.id,
  packageId: row.package_id,
  type: row.type as SubmissionPackageFileType,
  filename: row.filename,
  outcomeId: row.outcome_id,
  outcomeVersion: row.outcome_version,
  artifactPath: row.artifact_path,
  contentHash: row.content_hash,
  required: row.required === 1,
  validationStatus: row.validation_status as SubmissionPackageFileValidationStatus,
  note: row.note,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SubmissionPackageRepository {
  constructor(private readonly db: Database.Database) {}

  private packageRow(packageId: string): PackageRow | undefined {
    return this.db.prepare('SELECT * FROM submission_packages WHERE id = ?').get(packageId) as PackageRow | undefined;
  }

  /** frozen 硬边界：包不存在抛 not_found，已冻结抛 frozen。 */
  private assertDraftPackage(packageId: string): PackageRow {
    const row = this.packageRow(packageId);
    if (!row) throw new Error('submission_package_not_found');
    if (row.status === 'frozen') throw new Error('submission_package_frozen');
    return row;
  }

  // ── Preflight（run + checks，单事务落库） ────────────────────

  /**
   * 持久化一次预检：passed/blockCount/warnCount 由 checks 推导，
   * run 与全部 checks 在同一事务内写入。
   */
  savePreflightRun(
    caseId: string,
    outcomeId: string,
    outcomeVersion: number,
    checks: SubmissionPreflightCheckCreateInput[],
  ): { run: SubmissionPreflightRun; checks: SubmissionPreflightCheck[] } {
    const now = Date.now();
    const runId = 'spr-' + randomUUID();
    const blockCount = checks.filter((check) => check.level === 'block').length;
    const warnCount = checks.filter((check) => check.level === 'warn').length;
    this.db.transaction(() => {
      this.db.prepare(
        'INSERT INTO submission_preflight_runs (id,case_id,outcome_id,outcome_version,passed,block_count,warn_count,created_at) VALUES (?,?,?,?,?,?,?,?)',
      ).run(runId, caseId, outcomeId, outcomeVersion, blockCount === 0 ? 1 : 0, blockCount, warnCount, now);
      const insert = this.db.prepare(
        'INSERT INTO submission_preflight_checks (id,run_id,case_id,check_key,label,level,detail,source,created_at) VALUES (?,?,?,?,?,?,?,?,?)',
      );
      for (const check of checks) {
        insert.run(
          'spc-' + randomUUID(), runId, caseId, check.checkKey, check.label ?? '',
          check.level, check.detail ?? '', check.source ?? 'deterministic', now,
        );
      }
    })();
    return { run: this.latestPreflightRun(caseId)!, checks: this.listPreflightChecks(runId) };
  }

  /** 该 case 最近一次预检（同刻多次时按插入序取最后一条）。 */
  latestPreflightRun(caseId: string): SubmissionPreflightRun | undefined {
    const row = this.db.prepare(
      'SELECT * FROM submission_preflight_runs WHERE case_id = ? ORDER BY created_at DESC, rowid DESC LIMIT 1',
    ).get(caseId) as RunRow | undefined;
    return row ? asRun(row) : undefined;
  }

  listPreflightChecks(runId: string): SubmissionPreflightCheck[] {
    return (this.db.prepare('SELECT * FROM submission_preflight_checks WHERE run_id = ? ORDER BY created_at ASC, rowid ASC').all(runId) as CheckRow[]).map(asCheck);
  }

  // ── Package（材料清单，round 递增；frozen 后只读） ─────────────

  /** 新建投稿包：round = 该 case 已有包数 + 1（首轮 1，返修重投 2…）。 */
  createPackage(caseId: string): SubmissionPackage {
    const now = Date.now();
    const id = 'spkg-' + randomUUID();
    const count = (this.db.prepare('SELECT COUNT(*) AS n FROM submission_packages WHERE case_id = ?').get(caseId) as { n: number }).n;
    this.db.prepare(
      'INSERT INTO submission_packages (id,case_id,status,round,created_at,updated_at) VALUES (?,?,?,?,?,?)',
    ).run(id, caseId, 'draft', count + 1, now, now);
    return this.getPackage(id)!;
  }

  getPackage(packageId: string): SubmissionPackage | undefined {
    const row = this.packageRow(packageId);
    return row ? asPackage(row) : undefined;
  }

  /** 该 case 最新投稿包；指定 round 时取该轮。 */
  latestPackageForCase(caseId: string, round?: number): SubmissionPackage | undefined {
    const row = round !== undefined
      ? this.db.prepare('SELECT * FROM submission_packages WHERE case_id = ? AND round = ? ORDER BY created_at DESC LIMIT 1').get(caseId, round) as PackageRow | undefined
      : this.db.prepare('SELECT * FROM submission_packages WHERE case_id = ? ORDER BY round DESC, created_at DESC LIMIT 1').get(caseId) as PackageRow | undefined;
    return row ? asPackage(row) : undefined;
  }

  listPackages(caseId: string): SubmissionPackage[] {
    return (this.db.prepare('SELECT * FROM submission_packages WHERE case_id = ? ORDER BY round ASC, created_at ASC').all(caseId) as PackageRow[]).map(asPackage);
  }

  /** 登记一个投稿包文件（frozen 拒绝）。 */
  addPackageFile(packageId: string, input: SubmissionPackageFileCreateInput): SubmissionPackageFile {
    this.assertDraftPackage(packageId);
    const now = Date.now();
    const id = 'spf-' + randomUUID();
    this.db.prepare(
      'INSERT INTO submission_package_files (id,package_id,type,filename,outcome_id,outcome_version,artifact_path,content_hash,required,validation_status,note,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)',
    ).run(
      id, packageId, input.type, input.filename ?? '',
      input.outcomeId ?? null, input.outcomeVersion ?? null, input.artifactPath ?? null,
      input.contentHash ?? '', input.required ? 1 : 0,
      input.validationStatus ?? 'pending', input.note ?? '', now, now,
    );
    this.db.prepare('UPDATE submission_packages SET updated_at = ? WHERE id = ?').run(now, packageId);
    return asPackageFile(this.db.prepare('SELECT * FROM submission_package_files WHERE id = ?').get(id) as PackageFileRow);
  }

  /** 修改投稿包文件可变字段（frozen 拒绝）。 */
  updatePackageFile(packageId: string, fileId: string, patch: SubmissionPackageFilePatch): SubmissionPackageFile | undefined {
    this.assertDraftPackage(packageId);
    const row = this.db.prepare('SELECT * FROM submission_package_files WHERE id = ? AND package_id = ?').get(fileId, packageId) as PackageFileRow | undefined;
    if (!row) return undefined;
    const sets: string[] = [];
    const values: unknown[] = [];
    const assign = (column: string, value: unknown): void => { sets.push(`${column} = ?`); values.push(value); };
    if (patch.filename !== undefined) assign('filename', patch.filename);
    if (patch.outcomeId !== undefined) assign('outcome_id', patch.outcomeId);
    if (patch.outcomeVersion !== undefined) assign('outcome_version', patch.outcomeVersion);
    if (patch.artifactPath !== undefined) assign('artifact_path', patch.artifactPath);
    if (patch.contentHash !== undefined) assign('content_hash', patch.contentHash);
    if (patch.required !== undefined) assign('required', patch.required ? 1 : 0);
    if (patch.validationStatus !== undefined) assign('validation_status', patch.validationStatus);
    if (patch.note !== undefined) assign('note', patch.note);
    const now = Date.now();
    this.db.transaction(() => {
      if (sets.length > 0) {
        assign('updated_at', now);
        values.push(fileId);
        this.db.prepare(`UPDATE submission_package_files SET ${sets.join(', ')} WHERE id = ?`).run(...values);
      }
      this.db.prepare('UPDATE submission_packages SET updated_at = ? WHERE id = ?').run(now, packageId);
    })();
    return asPackageFile(this.db.prepare('SELECT * FROM submission_package_files WHERE id = ?').get(fileId) as PackageFileRow);
  }

  listPackageFiles(packageId: string): SubmissionPackageFile[] {
    return (this.db.prepare('SELECT * FROM submission_package_files WHERE package_id = ? ORDER BY created_at ASC, rowid ASC').all(packageId) as PackageFileRow[]).map(asPackageFile);
  }

  /** 移除投稿包文件（frozen 拒绝）。 */
  removePackageFile(packageId: string, fileId: string): boolean {
    this.assertDraftPackage(packageId);
    const now = Date.now();
    let removed = false;
    this.db.transaction(() => {
      removed = this.db.prepare('DELETE FROM submission_package_files WHERE id = ? AND package_id = ?').run(fileId, packageId).changes > 0;
      this.db.prepare('UPDATE submission_packages SET updated_at = ? WHERE id = ?').run(now, packageId);
    })();
    return removed;
  }

  /** 冻结投稿包：status → frozen 并打 frozenAt（幂等：已冻结直接返回现状）。 */
  freezePackage(packageId: string): SubmissionPackage | undefined {
    const row = this.packageRow(packageId);
    if (!row) return undefined;
    if (row.status !== 'frozen') {
      const now = Date.now();
      this.db.prepare("UPDATE submission_packages SET status = 'frozen', frozen_at = ?, updated_at = ? WHERE id = ? AND status = 'draft'").run(now, now, packageId);
    }
    return this.getPackage(packageId);
  }
}
