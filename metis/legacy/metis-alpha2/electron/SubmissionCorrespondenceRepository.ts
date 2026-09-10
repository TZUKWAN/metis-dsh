/**
 * SubmissionCorrespondenceRepository — 投稿通信 SQLite 仓储（P3/P4）。
 *
 * 风格与 SubmissionRepository 一致：单类持有 better-sqlite3 句柄、
 * 行→camelCase 私有映射。两个幂等键由数据库唯一索引兜底：
 *  - 外发 operation_id：重复发送请求返回原记录（alreadyRecorded=true），
 *    调用方据此跳过真实 SMTP 发送，杜绝重试重复发信；
 *  - 收件 (account_id, message_id)：IMAP 重复拉取不产生第二条记录。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  InboundCorrespondenceInputSchema,
  OutboundCorrespondenceInputSchema,
  SubmissionCorrespondenceSchema,
  type CorrespondenceClassification,
  type InboundCorrespondenceInput,
  type OutboundCorrespondenceInput,
  type SubmissionCorrespondence,
} from '../engine/submission/SubmissionCorrespondenceContract.js';

type Row = {
  id: string; project_id: string; case_id: string | null; direction: string;
  account_id: string | null; message_id: string; thread_id: string; operation_id: string | null;
  from_addr: string; to_addr: string; subject: string; body_text: string;
  attachment_names: string | null; attachment_texts: string | null;
  received_at: number | null; sent_at: number | null;
  classification: string; match_status: string; match_reason: string;
  created_at: number; updated_at: number;
};

/** JSON 列安全解析：空/损坏一律回退默认值，不因脏数据炸掉整表读取。 */
function parseJsonArray<T>(raw: string | null | undefined, fallback: T): T {
  if (!raw) return fallback;
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed as T : fallback;
  } catch {
    return fallback;
  }
}

const asRecord = (row: Row): SubmissionCorrespondence => SubmissionCorrespondenceSchema.parse({
  contractVersion: 1,
  id: row.id,
  projectId: row.project_id,
  caseId: row.case_id,
  direction: row.direction,
  accountId: row.account_id,
  messageId: row.message_id,
  threadId: row.thread_id,
  operationId: row.operation_id,
  fromAddr: row.from_addr,
  toAddr: row.to_addr,
  subject: row.subject,
  bodyText: row.body_text,
  attachmentNames: parseJsonArray(row.attachment_names, [] as string[]),
  attachmentTexts: parseJsonArray(row.attachment_texts, [] as Array<{ filename: string; text: string }>),
  receivedAt: row.received_at,
  sentAt: row.sent_at,
  classification: row.classification,
  matchStatus: row.match_status,
  matchReason: row.match_reason,
  createdAt: row.created_at,
  updatedAt: row.updated_at,
});

export class SubmissionCorrespondenceRepository {
  constructor(private readonly db: Database.Database) {}

  private byId(id: string): SubmissionCorrespondence | undefined {
    const row = this.db.prepare('SELECT * FROM submission_correspondence WHERE id = ?').get(id) as Row | undefined;
    return row ? asRecord(row) : undefined;
  }

  /** 收件登记：同账户同 Message-ID 去重（重复拉取返回已存在记录）。 */
  recordInbound(raw: unknown): { record: SubmissionCorrespondence; alreadyRecorded: boolean } {
    const input: InboundCorrespondenceInput = InboundCorrespondenceInputSchema.parse(raw);
    if (input.messageId) {
      const existing = this.db.prepare(
        "SELECT id FROM submission_correspondence WHERE direction = 'in' AND account_id = ? AND message_id = ?",
      ).get(input.accountId, input.messageId) as { id: string } | undefined;
      if (existing) return { record: this.byId(existing.id)!, alreadyRecorded: true };
    }
    const now = Date.now();
    const id = 'scr-' + randomUUID();
    // 自动匹配只是建议：无论是否命中都先挂 pending，等用户确认后才转 matched。
    this.db.prepare(`INSERT INTO submission_correspondence
      (id,project_id,case_id,direction,account_id,message_id,thread_id,operation_id,from_addr,to_addr,subject,body_text,attachment_names,attachment_texts,received_at,sent_at,classification,match_status,match_reason,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.projectId, input.suggestedCaseId, 'in', input.accountId, input.messageId, input.threadId, null,
      input.fromAddr, input.toAddr, input.subject, input.bodyText,
      JSON.stringify(input.attachmentNames), JSON.stringify(input.attachmentTexts),
      input.receivedAt, null,
      input.classification, 'pending', input.matchReason, now, now,
    );
    return { record: this.byId(id)!, alreadyRecorded: false };
  }

  /**
   * 外发登记：operationId 幂等。调用方必须在真实 SMTP 发送【之前】询问
   * findByOperationId —— 已存在则说明上一轮其实已发出/已记录，禁止重发。
   */
  findByOperationId(operationId: string): SubmissionCorrespondence | undefined {
    const row = this.db.prepare('SELECT * FROM submission_correspondence WHERE operation_id = ?').get(operationId) as Row | undefined;
    return row ? asRecord(row) : undefined;
  }

  recordOutbound(raw: unknown): { record: SubmissionCorrespondence; alreadyRecorded: boolean } {
    const input: OutboundCorrespondenceInput = OutboundCorrespondenceInputSchema.parse(raw);
    const existing = this.findByOperationId(input.operationId);
    if (existing) return { record: existing, alreadyRecorded: true };
    const now = Date.now();
    const id = 'scr-' + randomUUID();
    this.db.prepare(`INSERT INTO submission_correspondence
      (id,project_id,case_id,direction,account_id,message_id,thread_id,operation_id,from_addr,to_addr,subject,body_text,received_at,sent_at,classification,match_status,match_reason,created_at,updated_at)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
      id, input.projectId, input.caseId, 'out', input.accountId, input.messageId, '', input.operationId,
      '', input.toAddr, input.subject, input.bodyText, null, input.sentAt,
      'other', 'matched', '', now, now,
    );
    return { record: this.byId(id)!, alreadyRecorded: false };
  }

  listByCase(projectId: string, caseId: string): SubmissionCorrespondence[] {
    return (this.db.prepare(
      'SELECT * FROM submission_correspondence WHERE project_id = ? AND case_id = ? ORDER BY created_at ASC',
    ).all(projectId, caseId) as Row[]).map(asRecord);
  }

  /** 待确认关联的收件（含未能匹配任何 Case 的）。 */
  listPending(projectId: string): SubmissionCorrespondence[] {
    return (this.db.prepare(
      "SELECT * FROM submission_correspondence WHERE project_id = ? AND direction = 'in' AND match_status = 'pending' ORDER BY created_at DESC",
    ).all(projectId) as Row[]).map(asRecord);
  }

  /** 跨项目待确认收件（后台监听推导同步目标用）。 */
  listPendingAll(): SubmissionCorrespondence[] {
    return (this.db.prepare(
      "SELECT * FROM submission_correspondence WHERE direction = 'in' AND match_status = 'pending'",
    ).all() as Row[]).map(asRecord);
  }

  get(projectId: string, id: string): SubmissionCorrespondence | undefined {
    const row = this.db.prepare('SELECT * FROM submission_correspondence WHERE id = ? AND project_id = ?').get(id, projectId) as Row | undefined;
    return row ? asRecord(row) : undefined;
  }

  /** 用户确认/否认自动关联；确认时绑定 caseId，否认时解除并标记 rejected。 */
  resolveMatch(input: { projectId: string; id: string; approve: boolean; caseId?: string }): SubmissionCorrespondence | undefined {
    const record = this.get(input.projectId, input.id);
    if (!record) return undefined;
    const now = Date.now();
    if (input.approve) {
      const caseId = input.caseId ?? record.caseId;
      if (!caseId) throw new Error('correspondence_case_required');
      this.db.prepare("UPDATE submission_correspondence SET case_id = ?, match_status = 'matched', updated_at = ? WHERE id = ?")
        .run(caseId, now, record.id);
    } else {
      this.db.prepare("UPDATE submission_correspondence SET case_id = NULL, match_status = 'rejected', updated_at = ? WHERE id = ?")
        .run(now, record.id);
    }
    return this.byId(record.id);
  }

  updateClassification(projectId: string, id: string, classification: CorrespondenceClassification): SubmissionCorrespondence | undefined {
    const record = this.get(projectId, id);
    if (!record) return undefined;
    this.db.prepare('UPDATE submission_correspondence SET classification = ?, updated_at = ? WHERE id = ?')
      .run(classification, Date.now(), record.id);
    return this.byId(record.id);
  }
}
