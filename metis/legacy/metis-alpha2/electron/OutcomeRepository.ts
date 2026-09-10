/** Durable, project-scoped Outcomes persistence. */
import { createHash, randomUUID } from 'node:crypto';
import type Database from 'better-sqlite3';
import { OutcomeDocumentSchema, OutcomeIdSchema, OutcomeSourceLocateResultSchema, type OutcomeCategory, type OutcomeDocument, type OutcomeKind, type OutcomeSource, type OutcomeSourceLocateResult, type OutcomeSummary, type OutcomeTrashEntry, type OutcomeVersion } from '../engine/runtime/OutcomeRuntimeContract.js';
/** 成果回收站保留期：软删除 7 天后由惰性清理彻底删除。 */
export const OUTCOME_TRASH_RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
type OutcomeActor = 'human' | 'ai' | 'import' | 'restore';
type OutcomeStatus = 'draft' | 'final' | 'archived';

type OutcomeRow = { id: string; project_id: string; category_id: string | null; title: string; kind: OutcomeKind; status: OutcomeStatus; current_version: number; final_version: number | null; created_at: number; updated_at: number };
type VersionRow = { outcome_id: string; version: number; content: string; note: string; created_by: OutcomeActor; parent_version: number | null; sources_json: string; created_at: number };
type CategoryRow = { id: string; name: string; sort_order: number; created_at: number; updated_at: number };
type AssistantOutcomeRow = { id: string; title: string; kind: OutcomeKind; version: number; content: string; note: string; updated_at: number };
type AssistantArtifactRow = { id: string; title: string; artifact_type: string; version: number; content: string; updated_at: number };
export type OutcomeAssistantProjectRecord =
  | { type: 'other_outcome'; id: string; title: string; kind: OutcomeKind; version: number; document: OutcomeDocument; note: string; updatedAt: number }
  | { type: 'outcome_history'; id: string; title: string; kind: OutcomeKind; version: number; document: OutcomeDocument; note: string; updatedAt: number }
  | { type: 'artifact'; id: string; title: string; artifactType: string; version: number; content: string; updatedAt: number };
const encode = (value: unknown): string => JSON.stringify(value);
const decode = <T>(value: string, fallback: T): T => { try { return JSON.parse(value) as T; } catch { return fallback; } };
const hash = (value: unknown): string => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const asSummary = (row: OutcomeRow): OutcomeSummary => ({ id: row.id, projectId: row.project_id, categoryId: row.category_id, title: row.title, kind: row.kind, status: row.status, currentVersion: row.current_version, finalVersion: row.final_version, createdAt: row.created_at, updatedAt: row.updated_at });
const asVersion = (row: VersionRow): OutcomeVersion => ({ outcomeId: row.outcome_id, version: row.version, content: decode<OutcomeDocument>(row.content, { type: 'other', text: '', media: null }), note: row.note, createdBy: row.created_by, parentVersion: row.parent_version, sources: decode<OutcomeSource[]>(row.sources_json, []), createdAt: row.created_at });

export class OutcomeRepository {
  constructor(private readonly db: Database.Database) {}
  private assertProject(projectId: string): void { if (!this.db.prepare('SELECT id FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId)) throw new Error('outcome_project_not_found'); }
  private owned(projectId: string, outcomeId: string): OutcomeRow | undefined { return this.db.prepare('SELECT * FROM outcomes WHERE id = ? AND project_id = ? AND deleted_at IS NULL').get(outcomeId, projectId) as OutcomeRow | undefined; }

  listCategories(): OutcomeCategory[] { return (this.db.prepare('SELECT * FROM outcome_categories ORDER BY sort_order ASC, name COLLATE NOCASE ASC').all() as CategoryRow[]).map((row) => ({ id: row.id, name: row.name, sortOrder: row.sort_order, createdAt: row.created_at, updatedAt: row.updated_at })); }
  createCategory(name: string): OutcomeCategory { const now = Date.now(); const id = 'oc-' + randomUUID(); const max = this.db.prepare('SELECT COALESCE(MAX(sort_order), -1) AS max FROM outcome_categories').get() as { max: number }; this.db.prepare('INSERT INTO outcome_categories (id,name,sort_order,created_at,updated_at) VALUES (?,?,?,?,?)').run(id, name, max.max + 1, now, now); return { id, name, sortOrder: max.max + 1, createdAt: now, updatedAt: now }; }
  renameCategory(id: string, name: string): OutcomeCategory | undefined { this.db.prepare('UPDATE outcome_categories SET name = ?, updated_at = ? WHERE id = ?').run(name, Date.now(), id); return this.listCategories().find((item) => item.id === id); }
  deleteCategory(id: string): boolean { return this.db.prepare('DELETE FROM outcome_categories WHERE id = ?').run(id).changes > 0; }

  list(projectId: string, query = ''): OutcomeSummary[] { this.assertProject(projectId); const pattern = '%' + query.trim().replace(/[%_]/gu, '') + '%'; return (this.db.prepare('SELECT * FROM outcomes WHERE project_id = ? AND deleted_at IS NULL AND current_version > 0 AND title LIKE ? ORDER BY updated_at DESC').all(projectId, pattern) as OutcomeRow[]).map(asSummary); }
  get(projectId: string, outcomeId: string, requestedVersion?: number): { outcome: OutcomeSummary; version: OutcomeVersion } | undefined { const outcome = this.owned(projectId, outcomeId); if (!outcome || outcome.current_version < 1) return undefined; const row = this.db.prepare('SELECT * FROM outcome_versions WHERE outcome_id = ? AND version = ?').get(outcomeId, requestedVersion ?? outcome.current_version) as VersionRow | undefined; return row ? { outcome: asSummary(outcome), version: asVersion(row) } : undefined; }
  versions(projectId: string, outcomeId: string): OutcomeVersion[] { if (!this.owned(projectId, outcomeId)) return []; return (this.db.prepare('SELECT * FROM outcome_versions WHERE outcome_id = ? ORDER BY version DESC').all(outcomeId) as VersionRow[]).map(asVersion); }
  has(projectId: string, outcomeId: string): boolean { return Boolean(this.owned(projectId, outcomeId)); }
  reserve(input: { projectId: string; outcomeId: string; categoryId: string | null; title: string; kind: OutcomeKind }): string { this.assertProject(input.projectId); if (input.categoryId && !this.db.prepare('SELECT id FROM outcome_categories WHERE id = ?').get(input.categoryId)) throw new Error('outcome_category_not_found'); if (this.owned(input.projectId, input.outcomeId)) throw new Error('outcome_id_conflict'); const now = Date.now(); this.db.prepare('INSERT INTO outcomes (id,project_id,category_id,title,kind,status,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,0,?,?)').run(input.outcomeId,input.projectId,input.categoryId,input.title,input.kind,'draft',now,now); return input.outcomeId; }
  deleteReserved(projectId: string, outcomeId: string): boolean { return this.db.prepare('DELETE FROM outcomes WHERE id = ? AND project_id = ? AND current_version = 0').run(outcomeId, projectId).changes > 0; }

  create(input: { projectId: string; outcomeId?: string; categoryId: string | null; title: string; kind: OutcomeKind; content: OutcomeDocument; note: string; actor?: OutcomeActor }): { outcome: OutcomeSummary; version: OutcomeVersion } { this.assertProject(input.projectId); if (input.categoryId && !this.db.prepare('SELECT id FROM outcome_categories WHERE id = ?').get(input.categoryId)) throw new Error('outcome_category_not_found'); const now = Date.now(); const id = input.outcomeId ?? 'out-' + randomUUID(); const existing = this.owned(input.projectId, id); if (existing && existing.current_version !== 0) throw new Error('outcome_id_conflict'); const actor = input.actor ?? 'human'; this.db.transaction(() => { if (existing) this.db.prepare('UPDATE outcomes SET category_id = ?, title = ?, kind = ?, status = \'draft\', current_version = 1, updated_at = ? WHERE id = ? AND project_id = ? AND current_version = 0').run(input.categoryId,input.title,input.kind,now,id,input.projectId); else this.db.prepare('INSERT INTO outcomes (id,project_id,category_id,title,kind,status,current_version,created_at,updated_at) VALUES (?,?,?,?,?,?,1,?,?)').run(id,input.projectId,input.categoryId,input.title,input.kind,'draft',now,now); this.db.prepare('INSERT INTO outcome_versions (outcome_id,version,content,content_hash,note,created_by,parent_version,sources_json,created_at) VALUES (?,1,?,?,?,?,?,?,?)').run(id,encode(input.content),hash(input.content),input.note,actor,null,'[]',now); this.db.prepare('INSERT INTO outcome_changes (id,outcome_id,version,actor,operation,summary,context_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run('och-' + randomUUID(),id,1,actor,actor === 'import' ? 'import' : 'create',input.note,encode({sources:[]} ),now); })(); return this.get(input.projectId,id)!; }
  save(input: { projectId: string; outcomeId: string; baseVersion: number; content: OutcomeDocument; note: string; actor: OutcomeActor; sources: OutcomeSource[] }): { outcome: OutcomeSummary; version: OutcomeVersion } { const current = this.owned(input.projectId,input.outcomeId); if (!current) throw new Error('outcome_not_found'); if (current.current_version !== input.baseVersion) throw new Error('outcome_version_conflict'); const now = Date.now(); const next = current.current_version + 1; this.db.transaction(() => { this.db.prepare('INSERT INTO outcome_versions (outcome_id,version,content,content_hash,note,created_by,parent_version,sources_json,created_at) VALUES (?,?,?,?,?,?,?,?,?)').run(current.id,next,encode(input.content),hash(input.content),input.note,input.actor,current.current_version,encode(input.sources),now); this.db.prepare('UPDATE outcomes SET current_version = ?, updated_at = ? WHERE id = ?').run(next,now,current.id); this.db.prepare('INSERT INTO outcome_changes (id,outcome_id,version,actor,operation,summary,context_json,created_at) VALUES (?,?,?,?,?,?,?,?)').run('och-' + randomUUID(),current.id,next,input.actor,input.actor === 'ai' ? 'ai_apply' : 'edit',input.note,encode({sources:input.sources}),now); })(); return this.get(input.projectId,current.id)!; }
  restore(projectId: string, outcomeId: string, targetVersion: number, note: string): { outcome: OutcomeSummary; version: OutcomeVersion } { const target = this.get(projectId,outcomeId,targetVersion); if (!target) throw new Error('outcome_version_not_found'); return this.save({projectId,outcomeId,baseVersion:target.outcome.currentVersion,content:target.version.content,note:note || 'Restored version ' + targetVersion,actor:'restore',sources:target.version.sources}); }
  rename(projectId: string, outcomeId: string, title: string): OutcomeSummary | undefined { const row = this.owned(projectId,outcomeId); if (!row) return undefined; this.db.prepare('UPDATE outcomes SET title = ?, updated_at = ? WHERE id = ?').run(title,Date.now(),outcomeId); const changed = this.owned(projectId,outcomeId); return changed ? asSummary(changed) : undefined; }
  move(projectId: string, outcomeId: string, categoryId: string | null): OutcomeSummary | undefined { const row = this.owned(projectId,outcomeId); if (!row) return undefined; if (categoryId && !this.db.prepare('SELECT id FROM outcome_categories WHERE id = ?').get(categoryId)) throw new Error('outcome_category_not_found'); this.db.prepare('UPDATE outcomes SET category_id = ?, updated_at = ? WHERE id = ?').run(categoryId,Date.now(),outcomeId); const changed = this.owned(projectId,outcomeId); return changed ? asSummary(changed) : undefined; }
  markFinal(projectId: string, outcomeId: string, targetVersion: number): OutcomeSummary | undefined { const row = this.owned(projectId,outcomeId); if (!row || !this.get(projectId,outcomeId,targetVersion)) return undefined; this.db.prepare("UPDATE outcomes SET status = 'final', final_version = ?, updated_at = ? WHERE id = ?").run(targetVersion,Date.now(),outcomeId); return asSummary(this.owned(projectId,outcomeId)!); }

  // ── 回收站（软删除 + 7 天保留期 + 惰性到期清理）────────────────────
  // outcomes.deleted_at 列是 schema 预留的；所有读路径已带 deleted_at IS NULL
  // 过滤，因此这里只需写入/清除该列。彻底删除返回媒体 stored_name 列表，
  // 由 main 进程交给 OutcomeMediaService 做磁盘文件清理（best-effort）。
  /** 移入回收站：仅作用于未删除的成果，返回是否成功。 */
  archive(projectId: string, outcomeId: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE outcomes SET deleted_at = ?, updated_at = ? WHERE id = ? AND project_id = ? AND deleted_at IS NULL').run(now, now, outcomeId, projectId).changes > 0;
  }
  /** 回收站列表：按删除时间倒序，附带 7 天到期时间。 */
  listArchived(projectId: string): OutcomeTrashEntry[] {
    this.assertProject(projectId);
    const rows = this.db.prepare('SELECT * FROM outcomes WHERE project_id = ? AND deleted_at IS NOT NULL ORDER BY deleted_at DESC').all(projectId) as Array<OutcomeRow & { deleted_at: number }>;
    return rows.map((row) => ({ outcome: asSummary(row), deletedAt: row.deleted_at, expiresAt: row.deleted_at + OUTCOME_TRASH_RETENTION_MS }));
  }
  /** 从回收站恢复：清除 deleted_at，内容与版本原样保留。 */
  restoreArchived(projectId: string, outcomeId: string, now = Date.now()): boolean {
    return this.db.prepare('UPDATE outcomes SET deleted_at = NULL, updated_at = ? WHERE id = ? AND project_id = ? AND deleted_at IS NOT NULL').run(now, outcomeId, projectId).changes > 0;
  }
  /**
   * 彻底删除一个已在回收站中的成果：连带版本、变更记录、作用域对话与媒体行。
   * 返回待清理的媒体 stored_name 列表；成果不在回收站中（或未删除）时返回 null。
   */
  deletePermanent(projectId: string, outcomeId: string): string[] | null {
    const row = this.db.prepare('SELECT id FROM outcomes WHERE id = ? AND project_id = ? AND deleted_at IS NOT NULL').get(outcomeId, projectId) as { id: string } | undefined;
    if (!row) return null;
    const storedNames = (this.db.prepare('SELECT stored_name FROM outcome_media WHERE project_id = ? AND outcome_id = ?').all(projectId, outcomeId) as Array<{ stored_name: string }>).map((item) => item.stored_name);
    this.db.transaction(() => {
      const conversations = this.db.prepare('SELECT id FROM scoped_conversations WHERE project_id = ? AND outcome_id = ?').all(projectId, outcomeId) as Array<{ id: string }>;
      for (const conversation of conversations) this.db.prepare('DELETE FROM scoped_conversation_messages WHERE conversation_id = ?').run(conversation.id);
      this.db.prepare('DELETE FROM scoped_conversations WHERE project_id = ? AND outcome_id = ?').run(projectId, outcomeId);
      this.db.prepare('DELETE FROM outcome_changes WHERE outcome_id = ?').run(outcomeId);
      this.db.prepare('DELETE FROM outcome_versions WHERE outcome_id = ?').run(outcomeId);
      this.db.prepare('DELETE FROM outcome_media WHERE project_id = ? AND outcome_id = ?').run(projectId, outcomeId);
      this.db.prepare('DELETE FROM outcomes WHERE id = ? AND project_id = ?').run(outcomeId, projectId);
    })();
    return storedNames;
  }
  /**
   * 惰性到期清理：由列表类调用触发（而非渲染层定时器），跨过到期时刻重启
   * App 后下一次列表仍会清理。返回每个被清成果的媒体 stored_name 供磁盘清理。
   */
  purgeExpired(now = Date.now()): Array<{ projectId: string; outcomeId: string; storedNames: string[] }> {
    const cutoff = now - OUTCOME_TRASH_RETENTION_MS;
    const expired = this.db.prepare('SELECT id, project_id FROM outcomes WHERE deleted_at IS NOT NULL AND deleted_at <= ?').all(cutoff) as Array<{ id: string; project_id: string }>;
    const purged: Array<{ projectId: string; outcomeId: string; storedNames: string[] }> = [];
    for (const row of expired) {
      const storedNames = this.deletePermanent(row.project_id, row.id);
      if (storedNames) purged.push({ projectId: row.project_id, outcomeId: row.id, storedNames });
    }
    return purged;
  }

  /**
   * Returns only durable records owned by the requested project.  The assistant
   * context selector is responsible for relevance and character budgets; this
   * repository boundary is responsible for project ownership and document
   * contract decoding.  It intentionally does not expose source files, binary
   * uploads, or session-scoped legacy artifacts because they have no reliable
   * project binding/content reader on this path.
   */
  listAssistantProjectRecords(input: { projectId: string; outcomeId: string; includeOtherOutcomes: boolean; includeHistory: boolean; includeArtifacts: boolean; candidateLimit?: number; /** 任务2：显式选中的 artifact id（activeArtifactIds）；提供时只取这些（仍校验项目归属），不再按最近更新抓取。 */ artifactIds?: string[] }): OutcomeAssistantProjectRecord[] {
    const current = this.owned(input.projectId, input.outcomeId);
    if (!current) return [];
    const limit = Math.max(1, Math.min(input.candidateLimit ?? 8, 16));
    const records: OutcomeAssistantProjectRecord[] = [];
    const validId = (value: string): string | undefined => OutcomeIdSchema.safeParse(value).success ? value : undefined;
    const validDocument = (value: string): OutcomeDocument | undefined => { try { const parsed=OutcomeDocumentSchema.safeParse(JSON.parse(value)); return parsed.success ? parsed.data : undefined; } catch { return undefined; } };
    if (input.includeOtherOutcomes) {
      const rows = this.db.prepare(`SELECT o.id,o.title,o.kind,o.current_version AS version,v.content,v.note,o.updated_at FROM outcomes o JOIN outcome_versions v ON v.outcome_id=o.id AND v.version=o.current_version WHERE o.project_id=? AND o.id<>? AND o.deleted_at IS NULL ORDER BY o.updated_at DESC LIMIT ?`).all(input.projectId,input.outcomeId,limit) as AssistantOutcomeRow[];
      for (const row of rows) { const id=validId(row.id); const document=validDocument(row.content); if (id && document) records.push({type:'other_outcome',id,title:row.title,kind:row.kind,version:row.version,document,note:row.note,updatedAt:row.updated_at}); }
    }
    if (input.includeHistory) {
      const rows = this.db.prepare(`SELECT o.id,o.title,o.kind,v.version,v.content,v.note,o.updated_at FROM outcomes o JOIN outcome_versions v ON v.outcome_id=o.id WHERE o.id=? AND o.project_id=? AND o.deleted_at IS NULL AND v.version<? ORDER BY v.version DESC LIMIT ?`).all(input.outcomeId,input.projectId,current.current_version,limit) as AssistantOutcomeRow[];
      for (const row of rows) { const id=validId(row.id); const document=validDocument(row.content); if (id && document) records.push({type:'outcome_history',id,title:row.title,kind:row.kind,version:row.version,document,note:row.note,updatedAt:row.updated_at}); }
    }
    if (input.includeArtifacts) {
      if (input.artifactIds && input.artifactIds.length > 0) {
        // 任务2：只取显式选中的 artifact（activeArtifactIds），逐个按 id 读取并
        // 校验项目归属；非法/不属于本项目的 id 跳过（fail-closed）。
        for (const artifactId of input.artifactIds.slice(0, limit)) {
          const id = validId(artifactId);
          if (!id) continue;
          const row = this.db.prepare(`SELECT a.id,a.title,a.artifact_type,a.version,v.content,a.updated_at FROM research_artifacts a JOIN artifact_versions v ON v.artifact_id=a.id AND v.version=a.version WHERE a.id=? AND a.project_id=? AND a.deleted_at IS NULL AND length(v.content)>0`).get(id,input.projectId) as AssistantArtifactRow | undefined;
          if (row) records.push({type:'artifact',id:row.id,title:row.title,artifactType:row.artifact_type,version:row.version,content:row.content,updatedAt:row.updated_at});
        }
      } else if (input.artifactIds === undefined) {
        // 兼容路径：调用方未传 artifactIds（旧调用点）才按最近更新抓取；
        // 显式传空数组 = 「无选中成果」，不抓取任何 artifact。
        const rows = this.db.prepare(`SELECT a.id,a.title,a.artifact_type,a.version,v.content,a.updated_at FROM research_artifacts a JOIN artifact_versions v ON v.artifact_id=a.id AND v.version=a.version WHERE a.project_id=? AND a.deleted_at IS NULL AND length(v.content)>0 ORDER BY a.updated_at DESC LIMIT ?`).all(input.projectId,limit) as AssistantArtifactRow[];
        for (const row of rows) { const id=validId(row.id); if (id) records.push({type:'artifact',id,title:row.title,artifactType:row.artifact_type,version:row.version,content:row.content,updatedAt:row.updated_at}); }
      }
    }
    return records;
  }

  private conversation(input: { projectId: string; scope: 'outcome'|'scenario'|'submission'; outcomeId: string|null; scenarioId: string|null }): string { this.assertProject(input.projectId); if (input.outcomeId && !this.owned(input.projectId,input.outcomeId)) throw new Error('outcome_not_found'); const found = this.db.prepare('SELECT id FROM scoped_conversations WHERE project_id = ? AND scope_kind = ? AND outcome_id IS ? AND scenario_id IS ? ORDER BY updated_at DESC LIMIT 1').get(input.projectId,input.scope,input.outcomeId,input.scenarioId) as {id:string}|undefined; if(found) return found.id; const now=Date.now(); const id='conv-'+randomUUID(); this.db.prepare('INSERT INTO scoped_conversations (id,scope_kind,project_id,scenario_id,outcome_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,input.scope,input.projectId,input.scenarioId,input.outcomeId,'',now,now); return id; }
  listConversation(input: { projectId: string; scope: 'outcome'|'scenario'|'submission'; outcomeId: string|null; scenarioId: string|null }): Array<{id:string;role:'user'|'assistant'|'system';content:string;sources:OutcomeSource[];createdAt:number}> { const id=this.conversation(input); return (this.db.prepare('SELECT * FROM scoped_conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC').all(id) as Array<{id:string;role:'user'|'assistant'|'system';content:string;sources_json:string;created_at:number}>).map((row)=>({id:row.id,role:row.role,content:row.content,sources:decode<OutcomeSource[]>(row.sources_json,[]),createdAt:row.created_at})); }
  appendConversation(input: { projectId: string; scope: 'outcome'|'scenario'|'submission'; outcomeId: string|null; scenarioId: string|null; role:'user'|'assistant'|'system'; content:string; sources:OutcomeSource[] }): {id:string;role:'user'|'assistant'|'system';content:string;sources:OutcomeSource[];createdAt:number} { const conversationId=this.conversation(input); const now=Date.now(); const id='cmsg-'+randomUUID(); this.db.prepare('INSERT INTO scoped_conversation_messages (id,conversation_id,role,content,sources_json,created_at) VALUES (?,?,?,?,?,?)').run(id,conversationId,input.role,input.content,encode(input.sources),now); this.db.prepare('UPDATE scoped_conversations SET updated_at = ? WHERE id = ?').run(now,conversationId); this.autoTitle(conversationId, input.role, input.content); return {id,role:input.role,content:input.content,sources:input.sources,createdAt:now}; }

  /** 会话单元：列出某作用域下全部对话（新→旧），含消息数。 */
  listConversations(input: { projectId: string; scope: 'outcome'|'scenario'|'submission'; outcomeId: string|null; scenarioId: string|null }): Array<{id:string;title:string;messageCount:number;createdAt:number;updatedAt:number}> { this.assertProject(input.projectId); const rows=this.db.prepare('SELECT c.id,c.title,c.created_at,c.updated_at,(SELECT COUNT(*) FROM scoped_conversation_messages m WHERE m.conversation_id=c.id) AS message_count FROM scoped_conversations c WHERE c.project_id=? AND c.scope_kind=? AND c.outcome_id IS ? AND c.scenario_id IS ? ORDER BY c.updated_at DESC').all(input.projectId,input.scope,input.outcomeId,input.scenarioId) as Array<{id:string;title:string;created_at:number;updated_at:number;message_count:number}>; return rows.map((row)=>({id:row.id,title:row.title,messageCount:row.message_count,createdAt:row.created_at,updatedAt:row.updated_at})); }

  createConversation(input: { projectId: string; scope: 'outcome'|'scenario'|'submission'; outcomeId: string|null; scenarioId: string|null; title?: string }): {id:string;title:string;createdAt:number} { this.assertProject(input.projectId); if (input.outcomeId && !this.owned(input.projectId,input.outcomeId)) throw new Error('outcome_not_found'); const now=Date.now(); const id='conv-'+randomUUID(); const title=(input.title ?? '').slice(0,200); this.db.prepare('INSERT INTO scoped_conversations (id,scope_kind,project_id,scenario_id,outcome_id,title,created_at,updated_at) VALUES (?,?,?,?,?,?,?,?)').run(id,input.scope,input.projectId,input.scenarioId,input.outcomeId,title,now,now); return {id,title,createdAt:now}; }

  deleteConversation(input: { projectId: string; conversationId: string }): boolean { const owned=this.db.prepare('SELECT id FROM scoped_conversations WHERE id = ? AND project_id = ?').get(input.conversationId,input.projectId) as {id:string}|undefined; if(!owned) return false; this.db.prepare('DELETE FROM scoped_conversation_messages WHERE conversation_id = ?').run(input.conversationId); this.db.prepare('DELETE FROM scoped_conversations WHERE id = ?').run(input.conversationId); return true; }

  listMessagesByConversation(input: { projectId: string; conversationId: string }): Array<{id:string;role:'user'|'assistant'|'system';content:string;sources:OutcomeSource[];createdAt:number}> { const owned=this.db.prepare('SELECT id FROM scoped_conversations WHERE id = ? AND project_id = ?').get(input.conversationId,input.projectId) as {id:string}|undefined; if(!owned) throw new Error('conversation_not_found'); return (this.db.prepare('SELECT * FROM scoped_conversation_messages WHERE conversation_id = ? ORDER BY created_at ASC').all(input.conversationId) as Array<{id:string;role:'user'|'assistant'|'system';content:string;sources_json:string;created_at:number}>).map((row)=>({id:row.id,role:row.role,content:row.content,sources:decode<OutcomeSource[]>(row.sources_json,[]),createdAt:row.created_at})); }

  appendToConversation(input: { projectId: string; conversationId: string; role:'user'|'assistant'|'system'; content:string; sources:OutcomeSource[] }): {id:string;role:'user'|'assistant'|'system';content:string;sources:OutcomeSource[];createdAt:number} { const owned=this.db.prepare('SELECT id FROM scoped_conversations WHERE id = ? AND project_id = ?').get(input.conversationId,input.projectId) as {id:string}|undefined; if(!owned) throw new Error('conversation_not_found'); const now=Date.now(); const id='cmsg-'+randomUUID(); this.db.prepare('INSERT INTO scoped_conversation_messages (id,conversation_id,role,content,sources_json,created_at) VALUES (?,?,?,?,?,?)').run(id,input.conversationId,input.role,input.content,encode(input.sources),now); this.db.prepare('UPDATE scoped_conversations SET updated_at = ? WHERE id = ?').run(now,input.conversationId); this.autoTitle(input.conversationId, input.role, input.content); return {id,role:input.role,content:input.content,sources:input.sources,createdAt:now}; }

  private autoTitle(conversationId: string, role: 'user'|'assistant'|'system', content: string): void { if (role !== 'user' || !content.trim()) return; const row=this.db.prepare('SELECT title FROM scoped_conversations WHERE id = ?').get(conversationId) as {title:string}|undefined; if (!row || row.title.trim()) return; this.db.prepare('UPDATE scoped_conversations SET title = ? WHERE id = ?').run(content.trim().slice(0,80), conversationId); }

  /** OUT-11: resolve a persisted source to a locatable, project-owned target. */
  locateSource(input: { projectId: string; source: OutcomeSource }): OutcomeSourceLocateResult {
    const { projectId, source } = input;
    if (source.kind === 'artifact') {
      const owned = this.db.prepare('SELECT id,title FROM research_artifacts WHERE id = ? AND project_id = ? AND deleted_at IS NULL').get(source.id, projectId) as { id: string; title: string } | undefined;
      if (!owned) return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'source_not_found' });
      return OutcomeSourceLocateResultSchema.parse({ ok: true, kind: 'artifact', targetId: owned.id, label: `定位研究资料：${owned.title.slice(0, 420)}` });
    }
    if (source.kind === 'outcome_version') {
      const owned = this.db.prepare('SELECT id,title FROM outcomes WHERE id = ? AND project_id = ? AND deleted_at IS NULL').get(source.id, projectId) as { id: string; title: string } | undefined;
      if (!owned) return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'source_not_found' });
      return OutcomeSourceLocateResultSchema.parse({ ok: true, kind: 'outcome_version', targetId: owned.id, ...(source.version !== undefined ? { version: source.version } : {}), label: `定位成果：${owned.title.slice(0, 420)}` });
    }
    if (source.kind === 'project_metis') {
      const proj = this.db.prepare('SELECT id,title FROM projects WHERE id = ? AND deleted_at IS NULL').get(projectId) as { id: string; title: string } | undefined;
      if (!proj) return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'source_not_found' });
      return OutcomeSourceLocateResultSchema.parse({ ok: true, kind: 'project_metis', targetId: projectId, label: `定位项目 Metis.md：${proj.title.slice(0, 420)}` });
    }
    return OutcomeSourceLocateResultSchema.parse({ ok: false, code: 'source_not_locatable' });
  }
}
