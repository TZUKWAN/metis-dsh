/**
 * Structured persistence startup failures.
 *
 * A database that cannot be migrated or fails integrity/invariant checks must
 * stop the app at startup with a user-readable explanation — never degrade
 * into "run until the first `no such column`". These errors carry just enough
 * structured detail for the main process to log diagnostics and offer
 * recovery, while the user-facing message stays free of SQL stack traces.
 */

export type PersistenceStartupFailureCode =
  | 'schema_migration_failed'
  | 'integrity_check_failed'
  | 'schema_invariant_violation';

export interface PersistenceStartupErrorDetail {
  code: PersistenceStartupFailureCode;
  /** Version the migration pipeline stopped at (migration failures only). */
  failedVersion?: number;
  /** Pre-migration backup file created by the runner, when present. */
  backupPath?: string;
  /** Structured check report (integrity / invariant failures). */
  report?: unknown;
}

/** User-readable, Chinese, no SQL internals. */
function userMessageFor(detail: PersistenceStartupErrorDetail): string {
  switch (detail.code) {
    case 'schema_migration_failed':
      return '数据库升级失败，已自动保留升级前备份，原数据未被继续修改。';
    case 'integrity_check_failed':
      return '数据库完整性检查失败，原数据未被继续修改。';
    case 'schema_invariant_violation':
      return '数据库结构校验失败，原数据未被继续修改。';
  }
}

export class PersistenceStartupError extends Error {
  readonly detail: PersistenceStartupErrorDetail;
  readonly userMessage: string;

  constructor(detail: PersistenceStartupErrorDetail, technicalMessage: string) {
    super(technicalMessage);
    this.name = 'PersistenceStartupError';
    this.detail = detail;
    this.userMessage = userMessageFor(detail);
  }
}
