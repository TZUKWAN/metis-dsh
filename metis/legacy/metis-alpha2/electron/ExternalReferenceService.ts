/**
 * ExternalReferenceService — 外部模型引用存储（2026-09-05 刘总规格书）。
 *
 * 【零越界】这里只存「外部参考·非证据」条目：与 papers/sources/paper_project_links
 * 证据链物理隔离（独立表）。渲染层展示必须带非证据徽标；ScenarioWorkflow 的
 * 证据装配永远不读本表。
 * 写入路径强制经 Human Confirmation（IPC 层的确认卡），服务层只做净化校验与
 * digest 去重（同 digest + 同 project 的重复引用幂等返回已有条目）。
 *
 * 【任务2 上下文隔离】读取 API 必须显式声明 scope（listForScope /
 * listForProject / listForSession）；空 scope 抛 scope_required——null 不等于
 * 「所有 scope」，杜绝「空 query → 全局最近记录 → 装入 prompt」的串线路径。
 * listGlobal() 仅限管理/审计页显式浏览，禁止其返回值进入任何 LLM 上下文。
 */
import { randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import {
  normalizeExternalModelReference,
  externalReferenceDigest,
  type ExternalModelReference,
} from '../engine/runtime/ExternalReferenceContract.js';

interface ExternalRefRow {
  id: string; model: string; url: string; quoted_text: string; context_digest: string;
  captured_at: number; project_id: string | null; session_id: string | null; created_at: number;
}

function rowToReference(row: ExternalRefRow): ExternalModelReference {
  return {
    v: 1,
    id: row.id,
    model: row.model,
    url: row.url,
    quotedText: row.quoted_text,
    contextDigest: row.context_digest,
    capturedAt: row.captured_at,
    projectId: row.project_id,
    sessionId: row.session_id,
  };
}

export class ExternalReferenceService {
  constructor(private readonly db: Database.Database) {}

  /** 写入一条外部引用（确认卡通过后才调用）。同 digest 幂等。 */
  add(raw: unknown): { ok: true; reference: ExternalModelReference; duplicate: boolean } | { ok: false; issues: string[] } {
    const parsed = normalizeExternalModelReference(raw);
    if (!parsed.ok) return parsed;
    const reference = parsed.reference;
    const existing = this.db.prepare(
      'SELECT * FROM external_references WHERE context_digest = ? AND COALESCE(project_id, \'\') = COALESCE(?, \'\') ORDER BY captured_at DESC LIMIT 1',
    ).get(reference.contextDigest, reference.projectId) as ExternalRefRow | undefined;
    if (existing) return { ok: true, reference: rowToReference(existing), duplicate: true };
    // 自动 id 仅含时间戳+摘要，同文本跨项目可能撞主键——冲突时加随机尾段。
    let id = reference.id;
    if (this.db.prepare('SELECT 1 FROM external_references WHERE id = ?').get(id)) {
      id = `${id}-${randomUUID().replace(/-/g, '').slice(0, 8)}`;
    }
    const now = Date.now();
    this.db.prepare(`INSERT INTO external_references
      (id, model, url, quoted_text, context_digest, captured_at, project_id, session_id, created_at)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`)
      .run(id, reference.model, reference.url, reference.quotedText,
        reference.contextDigest, reference.capturedAt, reference.projectId, reference.sessionId, now);
    return { ok: true, reference: { ...reference, id }, duplicate: false };
  }

  /**
   * 【任务2 上下文隔离】按显式 scope 读取——进入 prompt 的唯一许可路径。
   * 语义（默认隔离，显式共享；null scope 不等于所有 scope）：
   * - sessionId + projectId 同时给出：本会话捕获的引用（会话后来挂到项目时
   *   project_id 允许为空或等于该项目）；绝不包含其他会话/其他项目的引用。
   * - 仅 sessionId：该会话捕获的引用。
   * - 仅 projectId：该项目名下的引用（项目级浏览）。
   * - 两者都缺省：抛错 scope_required——不再返回「全局最近」。
   */
  listForScope(scope: { projectId?: string; sessionId?: string; limit?: number }): ExternalModelReference[] {
    const projectId = typeof scope.projectId === 'string' && scope.projectId.trim() ? scope.projectId.trim() : undefined;
    const sessionId = typeof scope.sessionId === 'string' && scope.sessionId.trim() ? scope.sessionId.trim() : undefined;
    if (!projectId && !sessionId) {
      throw new Error('scope_required: external reference reads require an explicit projectId and/or sessionId');
    }
    if (sessionId && projectId) {
      return this.query({
        clauses: ["session_id = ?", "(project_id IS NULL OR project_id = ?)"],
        params: [sessionId, projectId],
        limit: scope.limit,
      });
    }
    if (sessionId) {
      return this.query({ clauses: ['session_id = ?'], params: [sessionId], limit: scope.limit });
    }
    return this.query({ clauses: ['project_id = ?'], params: [projectId!], limit: scope.limit });
  }

  /** 项目级读取（显式）：只返回 project_id 精确匹配的引用。 */
  listForProject(projectId: string): ExternalModelReference[] {
    if (!projectId?.trim()) {
      throw new Error('scope_required: listForProject requires a non-empty projectId');
    }
    return this.query({ clauses: ['project_id = ?'], params: [projectId.trim()] });
  }

  /** 会话级读取（显式）：只返回捕获时绑定该会话的引用。 */
  listForSession(sessionId: string): ExternalModelReference[] {
    if (!sessionId?.trim()) {
      throw new Error('scope_required: listForSession requires a non-empty sessionId');
    }
    return this.query({ clauses: ['session_id = ?'], params: [sessionId.trim()] });
  }

  /**
   * 全局浏览（仅限管理/审计页面显式调用）；返回全部最近记录。
   * 禁止把本方法的返回值装入任何 LLM 上下文。
   */
  listGlobal(limit?: number): ExternalModelReference[] {
    return this.query({ clauses: [], params: [], limit });
  }

  private query(input: { clauses: string[]; params: Array<string | number>; limit?: number }): ExternalModelReference[] {
    const where = input.clauses.length > 0 ? `WHERE ${input.clauses.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM external_references ${where} ORDER BY captured_at DESC LIMIT ?`,
    ).all(...input.params, Math.min(input.limit ?? 100, 500)) as ExternalRefRow[];
    return rows.map(rowToReference);
  }

  remove(id: string): boolean {
    const result = this.db.prepare('DELETE FROM external_references WHERE id = ?').run(id);
    return result.changes === 1;
  }

  digestOf(quotedText: string): string {
    return externalReferenceDigest(quotedText);
  }
}
