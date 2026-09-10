/**
 * SQLite-backed persistence store for sessions, messages, tool results, etc.
 * Uses better-sqlite3 for synchronous, high-performance access.
 */

import Database from 'better-sqlite3';
import { createHash } from 'node:crypto';
import { MigrationRunner, type MigrationResult } from './MigrationRunner.js';
import { UNIFIED_MIGRATIONS, ensureBaselineSchema } from './migrations.js';
import { runStartupHealthChecks, type StartupHealthReport } from './StartupHealth.js';
import { PersistenceStartupError, type PersistenceStartupFailureCode } from './errors.js';
import type { ChatMessage, ToolResult } from '../core/types.js';
import { ArtifactContentSchema } from '../runtime/ArtifactRuntimeContract.js';
import { AgentExecutionEventSchema, CHAT_RUNTIME_LIMITS, type AgentExecutionEvent } from '../runtime/ChatRuntimeContract.js';
import type { ExperimentMetadata } from '../runtime/ExperimentMetadataContract.js';

export interface SessionRecord {
  id: string;
  createdAt: number;
  lastActivity: number;
  messageCount: number;
  metadata: Record<string, unknown>;
  /** Owning project id (conversations can be exported with their project). */
  projectId?: string;
  /** 多对话架构(2026-09-04):当前工作线程的场景与工作对象,正式列存储。 */
  scenarioId?: string | null;
  activeArtifactIds?: string[];
}

export interface MessageRecord {
  id: number;
  sessionId: string;
  role: string;
  content: string;
  toolCallsJson: string | null;
  toolCallId: string | null;
  name: string | null;
  metadata: Record<string, unknown>;
  createdAt: number;
}

export interface AgentRunRecord {
  runId: string;
  sessionId: string;
  turnId: string;
  projectId?: string;
  status: string;
  startedAt: number;
  completedAt?: number;
  lastSequence: number;
  eventsPruned: boolean;
  terminalReason?: string;
  metadata: Record<string, unknown>;
}

export interface ArtifactCreateRecord {
  id: string;
  sessionId: string;
  name: string;
  type: string;
  path?: string;
  size?: string;
  content?: string;
  metadata?: Record<string, unknown>;
}

export interface ArtifactContentRecord {
  id: string;
  sessionId: string;
  name: string;
  type: string;
  content: string;
  createdAt: number;
}

/** Raw legacy `artifacts` row shape (session-owned historical table). */
interface LegacyArtifactRow {
  id: string;
  session_id: string;
  name: string;
  type: string;
  path: string | null;
  size: string | null;
  content: string | null;
  metadata: string;
  created_at: number;
}

/**
 * Project that takes ownership of artifacts from project-less sessions when such a
 * session is deleted, so no user-produced artifact is ever destroyed by a
 * conversation deletion (task 1 §五, 刘总 2026-09-06 decision).
 */
export const UNASSIGNED_ARTIFACT_PROJECT_ID = 'proj-unassigned-artifacts';

/** Deterministic project-owned mirror id for a legacy session artifact. */
function projectArtifactMirrorId(legacyArtifactId: string): string {
  return `ra-${legacyArtifactId}`;
}

// --- Literature triage helpers (round 304) ---

function splitIntoSentences(text: string): string[] {
  return text
    .split(/(?<=[.!?])\s+/)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

function truncate(text: string, max: number): string {
  const clean = text.replace(/\s+/g, ' ').trim();
  return clean.length <= max ? clean : clean.slice(0, max - 1).trimEnd() + '…';
}

function extractFirstSentence(sentences: string[]): string {
  const first = sentences[0];
  return first ? truncate(first, 160) : '';
}

function findSentenceWithKeywords(sentences: string[], keywords: string[]): string {
  const lower = keywords.map((k) => k.toLowerCase());
  for (const s of sentences) {
    const sl = s.toLowerCase();
    if (lower.some((k) => sl.includes(k))) {
      return truncate(s, 160);
    }
  }
  return '';
}

function formatPaperCitation(p: {
  authors: string[];
  year: number;
  title: string;
}): string {
  const authorPart = p.authors && p.authors.length > 0
    ? p.authors.length <= 2
      ? p.authors.join(' & ')
      : `${p.authors[0]} et al.`
    : 'Unknown';
  return truncate(`${authorPart} (${p.year})`, 80);
}

function classifyEvidence(abstract: string): 'empirical' | 'theoretical' | 'mixed' | 'unknown' {
  const lower = abstract.toLowerCase();
  const empiricalSignals = ['dataset', 'experiment', 'benchmark', '%', 'accuracy', 'f1', 'baseline', 'evaluation', 'ablation'];
  const theoreticalSignals = ['theorem', 'proof', 'lemma', 'we prove', 'bound', 'complexity', 'convergence', 'analysis shows'];
  const hasEmpirical = empiricalSignals.some((s) => lower.includes(s));
  const hasTheoretical = theoreticalSignals.some((s) => lower.includes(s));
  if (hasEmpirical && hasTheoretical) return 'mixed';
  if (hasEmpirical) return 'empirical';
  if (hasTheoretical) return 'theoretical';
  return 'unknown';
}

export class PersistenceStore {
  private readonly db: Database.Database;
  private readonly dbPath: string;
  private lastMigrationResult: MigrationResult | null = null;
  private lastHealthReport: StartupHealthReport | null = null;

  constructor(dbPath: string) {
    this.dbPath = dbPath;
    this.db = new Database(dbPath);
    try {
      // SQLite opens lazily: a corrupt or non-database file only fails here, on the
      // first real page read. That is an integrity failure (controlled recovery), not
      // an environment failure like a native-module ABI mismatch (which throws from
      // `new Database` above and keeps its original type for graceful degradation).
      this.db.pragma('journal_mode = WAL');
      this.db.pragma('foreign_keys = ON');
      this.initializeSchema();
    } catch (err) {
      // Fail-closed: never leak an open handle to a database the app must not use.
      try { this.db.close(); } catch { /* already closed */ }
      if (err instanceof PersistenceStartupError) throw err;
      const code = (err as { code?: unknown } | null)?.code;
      if (typeof code === 'string' && code.startsWith('SQLITE_')) {
        throw new PersistenceStartupError(
          { code: 'integrity_check_failed' },
          `database could not be opened: ${(err as Error).message}`,
        );
      }
      throw err;
    }
  }

  /**
   * Search the local library (papers + notes) for content matching a query.
   *
   * This is a lightweight keyword-based RAG retrieval for chat context. Future
   * iterations can add vector/embedding search.
   */
  /** 取第一个命中 token 前后各 ~120 字符的窗口；无命中返回 undefined。 */
  private snippetAround(haystack: string, tokens: string[]): string | undefined {
    for (const token of tokens) {
      const at = haystack.indexOf(token);
      if (at >= 0) {
        const start = Math.max(0, at - 120);
        const end = Math.min(haystack.length, at + token.length + 180);
        return `${start > 0 ? '…' : ''}${haystack.slice(start, end)}${end < haystack.length ? '…' : ''}`;
      }
    }
    return undefined;
  }

  /**
   * 任务2 上下文隔离：options.projectId 存在时（工具链从 ToolContext 传入），
   * 只返回「未归属项目的全局文献」或「归属当前项目」的 papers/notes——
   * 排除归属其他项目的文献（含 PDF 全文命中），堵住 A 项目会话检索并读出
   * B 项目文献片段的跨项目泄漏。缺省（管理页/导入去重等显式全局调用）行为不变。
   */
  searchLibrary(query: string, limit = 5, options?: { projectId?: string }): Array<{
    type: 'paper' | 'note';
    id: string;
    title: string;
    authors?: string;
    year?: number;
    snippet: string;
    sourceId?: string;
    score: number;
  }> {
    // 保留 Unicode 字母/数字（中文词、英文词均有效）；旧实现只留 a-z0-9，
    // 中文查询会被清空导致检索永远为空。
    const tokens = query
      .toLowerCase()
      .split(/\s+/)
      .map((t) => t.replace(/[^\p{L}\p{N}]/gu, ''))
      .filter((t) => t.length > 1);

    if (tokens.length === 0) return [];

    const likePatterns = tokens.map((t) => `%${t}%`);
    const scopeProjectId = typeof options?.projectId === 'string' && options.projectId.trim()
      ? options.projectId.trim()
      : undefined;
    // paper_project_links 是权威归属关系：有任意链接的 paper 按「链接到当前
    // 项目」放行，链接到其他项目的排除；完全未链接的属于用户全局文献库。
    const paperScopeClause = scopeProjectId
      ? 'AND (NOT EXISTS (SELECT 1 FROM paper_project_links l WHERE l.paper_id = papers.id) OR EXISTS (SELECT 1 FROM paper_project_links l WHERE l.paper_id = papers.id AND l.project_id = ?))'
      : '';
    const paperScopeParams = scopeProjectId ? [scopeProjectId] : [];
    const noteScopeClause = scopeProjectId
      ? 'AND (project_id IS NULL OR project_id = ?)'
      : '';
    const noteScopeParams = scopeProjectId ? [scopeProjectId] : [];

    const paperRows = this.db
      .prepare(
        `SELECT id, title, authors, year, abstract, pdf_text, doi, arxiv_id, notes FROM papers
         WHERE ${tokens.map(() => '(title LIKE ? OR abstract LIKE ? OR pdf_text LIKE ? OR notes LIKE ?)').join(' OR ')} ${paperScopeClause}`,
      )
      .all(...likePatterns.flatMap((p) => [p, p, p, p]), ...paperScopeParams) as Array<{
        id: string;
        title: string;
        authors: string;
        year: number;
        abstract: string;
        pdf_text: string;
        doi?: string;
        arxiv_id?: string;
        notes: string;
      }>;

    const noteRows = this.db
      .prepare(
        `SELECT id, title, content, tags, linked_paper_ids FROM notes
         WHERE ${tokens.map(() => '(title LIKE ? OR content LIKE ? OR tags LIKE ?)').join(' OR ')} ${noteScopeClause}`,
      )
      .all(...likePatterns.flatMap((p) => [p, p, p]), ...noteScopeParams) as Array<{
        id: string;
        title: string;
        content: string;
        tags: string;
        linked_paper_ids: string;
      }>;

    const scoredPapers = paperRows.map((row) => {
      const haystack = `${row.title} ${row.abstract} ${row.pdf_text} ${row.notes}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.split(token).length - 1), 0);
      return {
        type: 'paper' as const,
        id: row.id,
        title: row.title,
        authors: row.authors,
        year: row.year,
        // 命中词上下文窗口（全文检索时比"摘要前 300 字"更有用）。
        snippet: this.snippetAround(haystack, tokens) ?? (row.abstract || row.notes || row.pdf_text || row.title).slice(0, 300),
        sourceId: row.doi || row.arxiv_id || row.id,
        score,
      };
    });

    const scoredNotes = noteRows.map((row) => {
      const haystack = `${row.title} ${row.content} ${row.tags}`.toLowerCase();
      const score = tokens.reduce((sum, token) => sum + (haystack.split(token).length - 1), 0);
      return {
        type: 'note' as const,
        id: row.id,
        title: row.title,
        snippet: (row.content || row.title).slice(0, 300),
        sourceId: row.linked_paper_ids || row.id,
        score,
      };
    });

    return [...scoredPapers, ...scoredNotes]
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Startup schema pipeline (the authoritative one — see migrations.ts):
   *   1. baseline shape (SCHEMA_SQL, transactional, idempotent, every startup)
   *   2. versioned migrations (MigrationRunner + UNIFIED_MIGRATIONS, the single source
   *      of truth for column/index/data evolution beyond the baseline)
   *   3. startup health checks (quick_check / foreign_key_check / schema invariants)
   *
   * Any failure throws PersistenceStartupError so the main process can stop fail-closed
   * with a structured recovery state — this constructor never degrades into a
   * partially-migrated store.
   */
  private initializeSchema(): void {
    // 1. Baseline shape. Whole new tables keep arriving in SCHEMA_SQL; running it on
    //    every startup keeps any database's table set current. Fail-closed on error.
    let baseline: { createdObjects: number };
    try {
      baseline = ensureBaselineSchema(this.db);
    } catch (err) {
      throw new PersistenceStartupError(
        { code: 'schema_migration_failed' },
        `baseline schema failed: ${(err as Error).message}`,
      );
    }

    // 2. Versioned migrations. A failure rolls back its own transaction and stops the
    //    pipeline; the DB stays at the last good version (plus the runner's .bak file).
    const runner = new MigrationRunner(this.db, this.dbPath, UNIFIED_MIGRATIONS);
    const result = runner.run();
    this.lastMigrationResult = result;
    if (result.failed) {
      throw new PersistenceStartupError(
        {
          code: 'schema_migration_failed',
          failedVersion: result.failed.version,
          backupPath: result.backupPath,
        },
        `migration v${result.failed.version} (${result.failed.description}) failed: ${result.failed.error}`,
      );
    }
    if (baseline.createdObjects > 0) {
      try {
        this.db.prepare(`
          INSERT INTO migration_log
            (run_at, from_version, to_version, applied_versions, elapsed_ms, status, failed_version, error, recovery_action, backup_path)
          VALUES (?, ?, ?, ?, 0, 'baseline_applied', NULL, NULL, '', NULL)
        `).run(Date.now(), result.toVersion, result.toVersion, JSON.stringify([`baseline+${baseline.createdObjects}`]));
      } catch { /* observability only */ }
    }

    // 3. Startup health checks. Failures here mean the database must not be used.
    const health = runStartupHealthChecks(this.db);
    this.lastHealthReport = health;
    if (!health.ok) {
      const failed = health.checks.filter((check) => !check.ok);
      const code: PersistenceStartupFailureCode = failed.some((check) => check.name === 'schema_invariants')
        ? 'schema_invariant_violation'
        : 'integrity_check_failed';
      throw new PersistenceStartupError(
        { code, report: health },
        `startup health check failed: ${failed.map((check) => `${check.name}: ${check.detail}`).slice(0, 5).join(' | ')}`,
      );
    }
  }

  /** Migration result of this store's startup (for diagnostics / IPC). */
  getLastMigrationResult(): MigrationResult | null {
    return this.lastMigrationResult;
  }

  /** Startup health report of this store (for diagnostics / IPC). */
  getStartupHealthReport(): StartupHealthReport | null {
    return this.lastHealthReport;
  }

  /** Rebuild the FTS5 index from the papers table (idempotent, fast). */
  reindexPapersFts(): void {
    try {
      this.db.exec(`
        INSERT INTO papers_fts(papers_fts) VALUES('rebuild');
      `);
    } catch { /* FTS5 unavailable */ }
  }

  /** Get the raw database instance (for advanced queries). */
  get raw(): Database.Database {
    return this.db;
  }

  // ─── Sessions ───────────────────────────────────────────────

  createSession(sessionId: string, metadata?: Record<string, unknown>, projectId?: string): string {
    const now = Date.now();
    this.db.prepare(
      'INSERT OR IGNORE INTO sessions (id, created_at, last_activity, message_count, metadata, project_id) VALUES (?, ?, ?, 0, ?, ?)',
    ).run(sessionId, now, now, JSON.stringify(metadata ?? {}), projectId ?? null);
    return sessionId;
  }

  getSession(sessionId: string): SessionRecord | undefined {
    const row = this.db.prepare('SELECT * FROM sessions WHERE id = ?').get(sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.mapSessionRow(row);
  }

  private mapSessionRow(row: Record<string, unknown>): SessionRecord {
    let activeArtifactIds: string[] | undefined;
    if (typeof row.active_artifact_ids === 'string' && row.active_artifact_ids) {
      try {
        const parsed = JSON.parse(row.active_artifact_ids) as unknown;
        if (Array.isArray(parsed)) activeArtifactIds = parsed.filter((item): item is string => typeof item === 'string');
      } catch { activeArtifactIds = undefined; }
    }
    return {
      id: row.id as string,
      createdAt: row.created_at as number,
      lastActivity: row.last_activity as number,
      messageCount: row.message_count as number,
      metadata: JSON.parse((row.metadata as string) || '{}'),
      projectId: (row.project_id as string | null) ?? undefined,
      scenarioId: (row.scenario_id as string | null | undefined) ?? undefined,
      activeArtifactIds,
    };
  }

  listSessions(limit = 50, offset = 0, filter?: { projectId?: string; includeArchived?: boolean }): SessionRecord[] {
    // 多对话架构(2026-09-04):支持按 projectId 过滤;归档默认隐藏(title/archived 在 metadata JSON)。
    const conditions: string[] = [];
    const params: Array<string | number> = [];
    if (filter?.projectId) {
      conditions.push('project_id = ?');
      params.push(filter.projectId);
    }
    if (!filter?.includeArchived) {
      conditions.push("COALESCE(json_extract(metadata, '$.archived'), 0) = 0");
    }
    const where = conditions.length > 0 ? ` WHERE ${conditions.join(' AND ')}` : '';
    const rows = this.db.prepare(
      `SELECT * FROM sessions${where} ORDER BY last_activity DESC LIMIT ? OFFSET ?`,
    ).all(...params, limit, offset) as Record<string, unknown>[];
    return rows.map((row) => this.mapSessionRow(row));
  }

  touchSession(sessionId: string): void {
    this.db.prepare('UPDATE sessions SET last_activity = ? WHERE id = ?').run(Date.now(), sessionId);
  }

  updateSession(sessionId: string, patch: Partial<Pick<SessionRecord, 'lastActivity' | 'messageCount' | 'scenarioId' | 'activeArtifactIds' | 'projectId'> & { metadata: Record<string, unknown> }>): void {
    const existing = this.getSession(sessionId);
    if (!existing) return;
    const metadata = { ...existing.metadata, ...(patch.metadata ?? {}) };
    const lastActivity = patch.lastActivity ?? existing.lastActivity;
    const messageCount = patch.messageCount ?? existing.messageCount;
    const scenarioId = patch.scenarioId !== undefined ? patch.scenarioId : existing.scenarioId ?? null;
    const activeArtifactIds = patch.activeArtifactIds !== undefined ? JSON.stringify(patch.activeArtifactIds) : (existing.activeArtifactIds ? JSON.stringify(existing.activeArtifactIds) : null);
    // 任务2：projectId 仅在 patch 显式给出时更新（ChatTurnService 只允许
    // 无主 session 的首次显式绑定，改绑由 scope_mismatch 校验拒绝）。
    const projectId = patch.projectId !== undefined ? patch.projectId : existing.projectId ?? null;
    this.db.prepare(
      'UPDATE sessions SET last_activity = ?, message_count = ?, metadata = ?, scenario_id = ?, active_artifact_ids = ?, project_id = ? WHERE id = ?',
    ).run(lastActivity, messageCount, JSON.stringify(metadata), scenarioId, activeArtifactIds, projectId, sessionId);
  }

  /**
   * Deletes a conversation. Messages, transient runs and checkpoints go away with the
   * session, but the artifacts the session produced are PROJECT assets: they are
   * migrated (idempotently, into the owning project or the system unassigned project)
   * to research_artifacts/artifact_versions inside the same transaction before the
   * session row goes away and the legacy session-owned cascade fires.
   */
  deleteSession(sessionId: string): void {
    this.db.transaction(() => {
      const session = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?').get(sessionId) as { project_id: string | null } | undefined;
      const artifacts = this.db.prepare('SELECT * FROM artifacts WHERE session_id = ?').all(sessionId) as LegacyArtifactRow[];
      const targetProjectId = session?.project_id ?? UNASSIGNED_ARTIFACT_PROJECT_ID;
      for (const artifact of artifacts) {
        this.mirrorLegacyArtifactToProject(artifact, targetProjectId, { migrated: true });
      }
      this.db.prepare('DELETE FROM agent_events WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM agent_runs WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM tool_results WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM checkpoints WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM messages WHERE session_id = ?').run(sessionId);
      this.db.prepare('DELETE FROM sessions WHERE id = ?').run(sessionId);
    })();
  }

  // ─── Messages ───────────────────────────────────────────────

  appendMessage(
    sessionId: string,
    role: string,
    content: string,
    options?: { toolCalls?: string; toolCallId?: string; name?: string; metadata?: Record<string, unknown> },
  ): number {
    const now = Date.now();
    const result = this.db.prepare(
      'INSERT INTO messages (session_id, role, content, tool_calls, tool_call_id, name, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sessionId,
      role,
      content,
      options?.toolCalls ?? null,
      options?.toolCallId ?? null,
      options?.name ?? null,
      JSON.stringify(options?.metadata ?? {}),
      now,
    );
    this.db.prepare('UPDATE sessions SET message_count = message_count + 1, last_activity = ? WHERE id = ?').run(now, sessionId);
    return Number(result.lastInsertRowid);
  }

  getMessages(
    sessionId: string,
    limit?: number,
    options?: { includeMetadata?: boolean },
  ): ChatMessage[] {
    const query = limit
      ? 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC LIMIT ?'
      : 'SELECT * FROM messages WHERE session_id = ? ORDER BY created_at ASC';
    const rows = (limit ? this.db.prepare(query).all(sessionId, limit) : this.db.prepare(query).all(sessionId)) as Record<string, unknown>[];
    const includeMetadata = options?.includeMetadata === true;

    return rows.map((row) => {
      const msg: ChatMessage = {
        role: row.role as ChatMessage['role'],
        content: row.content as string,
      };
      if (row.tool_calls) {
        try { msg.toolCalls = JSON.parse(row.tool_calls as string); } catch { /* skip */ }
      }
      if (row.tool_call_id) msg.toolCallId = row.tool_call_id as string;
      if (row.name) msg.name = row.name as string;
      if (includeMetadata) {
        try {
          const metadata = JSON.parse((row.metadata as string) || '{}') as Record<string, unknown>;
          if (metadata && typeof metadata === 'object' && !Array.isArray(metadata)
            && Object.keys(metadata).length > 0) msg.metadata = metadata;
        } catch { /* malformed message metadata is ignored at the boundary */ }
      }
      return msg;
    });
  }

  getMessageCount(sessionId: string): number {
    const row = this.db.prepare('SELECT COUNT(*) as cnt FROM messages WHERE session_id = ?').get(sessionId) as Record<string, unknown>;
    return (row?.cnt as number) ?? 0;
  }

  truncateMessagesAfterLastUser(sessionId: string): number {
    const lastUser = this.db.prepare(
      "SELECT id FROM messages WHERE session_id = ? AND role = 'user' ORDER BY id DESC LIMIT 1",
    ).get(sessionId) as { id: number } | undefined;
    if (!lastUser) return 0;

    const removeMessages = this.db.transaction(() => {
      const result = this.db.prepare(
        'DELETE FROM messages WHERE session_id = ? AND id > ?',
      ).run(sessionId, lastUser.id);
      this.db.prepare(
        'UPDATE sessions SET message_count = (SELECT COUNT(*) FROM messages WHERE session_id = ?), last_activity = ? WHERE id = ?',
      ).run(sessionId, Date.now(), sessionId);
      return result.changes;
    });

    return removeMessages();
  }

  // ─── Tool Results ───────────────────────────────────────────

  recordToolResult(sessionId: string, result: ToolResult): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT INTO tool_results (session_id, tool_name, tool_call_id, content, status, error, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      sessionId,
      result.toolName,
      result.toolCallId,
      result.content,
      result.status,
      result.error ?? null,
      JSON.stringify(result.metadata),
      now,
    );
    this.touchSession(sessionId);
  }

  getToolResults(sessionId: string): ToolResult[] {
    const rows = this.db.prepare(
      'SELECT * FROM tool_results WHERE session_id = ? ORDER BY created_at ASC',
    ).all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => ({
      toolName: row.tool_name as string,
      content: row.content as string,
      status: row.status as 'ok' | 'error',
      toolCallId: row.tool_call_id as string,
      error: (row.error as string) || undefined,
      metadata: JSON.parse((row.metadata as string) || '{}'),
    }));
  }

  // ─── Checkpoints ────────────────────────────────────────────

  recordCheckpoint(
    sessionId: string,
    phase: string,
    status: string,
    turnIndex: number,
    metadata?: Record<string, unknown>,
  ): string {
    const id = `cp_${Date.now()}_${Math.random().toString(36).slice(2, 8)}`;
    this.db.prepare(
      'INSERT INTO checkpoints (id, session_id, phase, status, turn_index, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(id, sessionId, phase, status, turnIndex, JSON.stringify(metadata ?? {}), Date.now());
    return id;
  }

  getCheckpoints(sessionId: string): Array<{ id: string; phase: string; status: string; turnIndex: number; metadata: Record<string, unknown>; createdAt: number }> {
    const rows = this.db.prepare(
      'SELECT * FROM checkpoints WHERE session_id = ? ORDER BY created_at ASC',
    ).all(sessionId) as Record<string, unknown>[];

    return rows.map((row) => ({
      id: row.id as string,
      phase: row.phase as string,
      status: row.status as string,
      turnIndex: row.turn_index as number,
      metadata: JSON.parse((row.metadata as string) || '{}'),
      createdAt: row.created_at as number,
    }));
  }

  // ─── Workflow Runs ──────────────────────────────────────────

  saveWorkflowRun(run: {
    id: string; workflowId: string; status: string; currentStepId: string | null;
    stepResults: Record<string, unknown>; input: Record<string, unknown>;
    errors: string[]; startedAt: number; completedAt: number | null;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO workflow_runs
       (id, workflow_id, status, current_step_id, step_results, input, errors, started_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id, run.workflowId, run.status, run.currentStepId,
      JSON.stringify(run.stepResults), JSON.stringify(run.input),
      JSON.stringify(run.errors), run.startedAt, run.completedAt,
    );
  }

  getWorkflowRun(runId: string): Record<string, unknown> | undefined {
    const row = this.db.prepare('SELECT * FROM workflow_runs WHERE id = ?').get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      ...row,
      step_results: JSON.parse((row.step_results as string) || '{}'),
      input: JSON.parse((row.input as string) || '{}'),
      errors: JSON.parse((row.errors as string) || '[]'),
    };
  }

  // ─── Eval Runs ──────────────────────────────────────────────

  saveEvalRun(run: {
    id: string; suiteName: string; status: string; successRate: number;
    taskCount: number; passedCount: number; resultsJson: string; createdAt: number; completedAt?: number;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO eval_runs
       (id, suite_name, status, success_rate, task_count, passed_count, results_json, created_at, completed_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      run.id, run.suiteName, run.status, run.successRate,
      run.taskCount, run.passedCount, run.resultsJson,
      run.createdAt, run.completedAt ?? null,
    );
  }

  // ─── Papers ─────────────────────────────────────────────────

  savePaper(paper: {
    id: string; title: string; authors: string[]; year: number; venue: string;
    abstract: string; doi?: string; arxivId?: string; pdfPath?: string; pdfUrl?: string; pdfText?: string;
    citationCount?: number; tags: string[]; notes: string; readStatus: string; rating: number; addedAt: number;
    projectId?: string;
    referenceIds?: string[];
  }): void {
    this.db.prepare(
      `INSERT INTO papers
       (id, title, authors, year, venue, abstract, doi, arxiv_id, pdf_path, pdf_url, pdf_text, citation_count, tags, notes, read_status, rating, added_at, project_id, reference_ids)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         title = excluded.title,
         authors = excluded.authors,
         year = excluded.year,
         venue = excluded.venue,
         abstract = excluded.abstract,
         doi = excluded.doi,
         arxiv_id = excluded.arxiv_id,
         pdf_path = excluded.pdf_path,
         pdf_url = excluded.pdf_url,
         pdf_text = excluded.pdf_text,
         citation_count = excluded.citation_count,
         tags = excluded.tags,
         notes = excluded.notes,
         read_status = excluded.read_status,
         rating = excluded.rating,
         added_at = excluded.added_at,
         project_id = COALESCE(papers.project_id, excluded.project_id),
         reference_ids = excluded.reference_ids`,
    ).run(
      paper.id, paper.title, JSON.stringify(paper.authors), paper.year, paper.venue,
      paper.abstract, paper.doi ?? null, paper.arxivId ?? null, paper.pdfPath ?? null, paper.pdfUrl ?? null,
      paper.pdfText ?? '', paper.citationCount ?? 0, JSON.stringify(paper.tags), paper.notes, paper.readStatus, paper.rating, paper.addedAt,
      paper.projectId ?? null, JSON.stringify(paper.referenceIds ?? []),
    );
  }

  /** Link (or unlink) a library paper to a project. */
  setPaperProjectId(paperId: string, projectId: string | null): boolean {
    const result = this.db.prepare('UPDATE papers SET project_id = ? WHERE id = ?').run(projectId, paperId);
    return result.changes > 0;
  }

  /**
   * Lightweight paper list for UI rendering: excludes the heavy pdfText and
   * abstract columns (which can be tens of KB per row) and supports keyset
   * pagination so a library of thousands of papers does not pull every large
   * field into memory at once. Use getPapers() when full text is required.
   */
  listPaperSummaries(options: { limit?: number; beforeAddedAt?: number } = {}): Array<{
    id: string; title: string; authors: string[]; year: number; venue: string;
    doi?: string; arxivId?: string; pdfPath?: string; pdfUrl?: string;
    citationCount?: number; tags: string[]; readStatus: string; rating: number; addedAt: number;
  }> {
    const limit = Math.max(1, Math.min(500, options.limit ?? 100));
    const stmt = options.beforeAddedAt !== undefined
      ? this.db.prepare('SELECT id, title, authors, year, venue, doi, arxiv_id, pdf_path, pdf_url, citation_count, tags, read_status, rating, added_at FROM papers WHERE added_at < ? ORDER BY added_at DESC LIMIT ?')
      : this.db.prepare('SELECT id, title, authors, year, venue, doi, arxiv_id, pdf_path, pdf_url, citation_count, tags, read_status, rating, added_at FROM papers ORDER BY added_at DESC LIMIT ?');
    const rows = (options.beforeAddedAt !== undefined
      ? stmt.all(options.beforeAddedAt, limit)
      : stmt.all(limit)) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      authors: JSON.parse((row.authors as string) || '[]'),
      year: row.year as number,
      venue: row.venue as string,
      doi: (row.doi as string) || undefined,
      arxivId: (row.arxiv_id as string) || undefined,
      pdfPath: (row.pdf_path as string) || undefined,
      pdfUrl: (row.pdf_url as string) || undefined,
      citationCount: (row.citation_count as number) || undefined,
      tags: JSON.parse((row.tags as string) || '[]'),
      readStatus: row.read_status as string,
      rating: row.rating as number,
      addedAt: row.added_at as number,
    }));
  }

  getPapers(): Array<{
    id: string; title: string; authors: string[]; year: number; venue: string;
    abstract: string; doi?: string; arxivId?: string; pdfPath?: string; pdfUrl?: string; pdfText?: string;
    citationCount?: number; tags: string[]; notes: string; readStatus: string; rating: number; addedAt: number;
    projectId?: string;
    projectIds: string[];
    referenceIds: string[];
  }> {
    const rows = this.db.prepare('SELECT * FROM papers ORDER BY added_at DESC').all() as Record<string, unknown>[];
    const linkRows = this.db.prepare(
      'SELECT paper_id, project_id FROM paper_project_links ORDER BY linked_at ASC, project_id ASC',
    ).all() as Array<{ paper_id: string; project_id: string }>;
    const projectIdsByPaper = new Map<string, string[]>();
    for (const link of linkRows) {
      const projectIds = projectIdsByPaper.get(link.paper_id) ?? [];
      projectIds.push(link.project_id);
      projectIdsByPaper.set(link.paper_id, projectIds);
    }
    return rows.map((row) => ({
      id: row.id as string,
      title: row.title as string,
      authors: JSON.parse((row.authors as string) || '[]'),
      year: row.year as number,
      venue: row.venue as string,
      abstract: row.abstract as string,
      doi: (row.doi as string) || undefined,
      arxivId: (row.arxiv_id as string) || undefined,
      pdfPath: (row.pdf_path as string) || undefined,
      pdfUrl: (row.pdf_url as string) || undefined,
      pdfText: (row.pdf_text as string) || undefined,
      citationCount: (row.citation_count as number) || undefined,
      tags: JSON.parse((row.tags as string) || '[]'),
      notes: row.notes as string,
      readStatus: row.read_status as string,
      rating: row.rating as number,
      addedAt: row.added_at as number,
      projectId: projectIdsByPaper.get(row.id as string)?.[0]
        ?? (row.project_id as string | null)
        ?? undefined,
      projectIds: projectIdsByPaper.get(row.id as string) ?? [],
      referenceIds: JSON.parse((row.reference_ids as string) || '[]'),
    }));
  }

  deletePaper(id: string): void {
    this.db.prepare('DELETE FROM papers WHERE id = ?').run(id);
  }

  /**
   * Find duplicate papers in the local library by DOI, arXiv ID, or normalized title.
   */
  findDuplicatePapers(): Array<{
    type: 'doi' | 'arxiv' | 'title';
    key: string;
    papers: ReturnType<PersistenceStore['getPapers']>;
  }> {
    const papers = this.getPapers();
    const byDoi = new Map<string, ReturnType<PersistenceStore['getPapers']>>();
    const byArxiv = new Map<string, ReturnType<PersistenceStore['getPapers']>>();
    const byTitle = new Map<string, ReturnType<PersistenceStore['getPapers']>>();

    function normalizeTitle(title: string): string {
      return title
        .toLowerCase()
        .replace(/[^a-z0-9\u4e00-\u9fa5]/g, '')
        .trim();
    }

    for (const paper of papers) {
      if (paper.doi?.trim()) {
        const doi = paper.doi.trim().toLowerCase();
        const group = byDoi.get(doi) ?? [];
        group.push(paper);
        byDoi.set(doi, group);
      }

      if (paper.arxivId?.trim()) {
        const arxivId = paper.arxivId.trim().toLowerCase();
        const group = byArxiv.get(arxivId) ?? [];
        group.push(paper);
        byArxiv.set(arxivId, group);
      }

      const normalized = normalizeTitle(paper.title);
      if (normalized.length > 5) {
        const group = byTitle.get(normalized) ?? [];
        group.push(paper);
        byTitle.set(normalized, group);
      }
    }

    const groups: Array<{ type: 'doi' | 'arxiv' | 'title'; key: string; papers: ReturnType<PersistenceStore['getPapers']> }> = [];
    for (const [key, group] of byDoi.entries()) {
      if (group.length > 1) groups.push({ type: 'doi', key, papers: group });
    }
    for (const [key, group] of byArxiv.entries()) {
      if (group.length > 1) groups.push({ type: 'arxiv', key, papers: group });
    }
    for (const [key, group] of byTitle.entries()) {
      if (group.length > 1) groups.push({ type: 'title', key, papers: group });
    }

    return groups;
  }

  /**
   * Delete duplicate papers, keeping the most complete entry in each group.
   *
   * Completeness heuristic (in order of priority):
   * 1. Explicit keepId if it belongs to the group.
   * 2. Longest PDF text / richest metadata.
   * 3. Highest citation count.
   * 4. Earliest added (stable tie-breaker).
   *
   * Returns the list of deleted paper IDs and the groups they came from.
   */
  deleteDuplicatePapers(keepId?: string): Array<{
    type: 'doi' | 'arxiv' | 'title';
    key: string;
    keptId: string;
    deletedIds: string[];
  }> {
    const groups = this.findDuplicatePapers();
    const result: Array<{ type: 'doi' | 'arxiv' | 'title'; key: string; keptId: string; deletedIds: string[] }> = [];

    function score(paper: ReturnType<PersistenceStore['getPapers']>[number]): number {
      let s = 0;
      if (paper.pdfText && paper.pdfText.length > 100) s += Math.min(paper.pdfText.length / 1000, 50);
      if (paper.doi?.trim()) s += 10;
      if (paper.arxivId?.trim()) s += 8;
      if (paper.abstract?.trim()) s += 5;
      if (paper.authors && paper.authors.length > 0) s += 3;
      if (paper.venue?.trim()) s += 2;
      if (paper.notes?.trim()) s += 2;
      s += (paper.citationCount ?? 0) / 10;
      return s;
    }

    for (const group of groups) {
      let kept = group.papers[0]!;

      if (keepId && group.papers.some((p) => p.id === keepId)) {
        kept = group.papers.find((p) => p.id === keepId)!;
      } else {
        for (const paper of group.papers) {
          if (score(paper) > score(kept)) kept = paper;
          else if (score(paper) === score(kept) && paper.addedAt < kept.addedAt) kept = paper;
        }
      }

      const deletedIds: string[] = [];
      for (const paper of group.papers) {
        if (paper.id !== kept.id) {
          this.deletePaper(paper.id);
          deletedIds.push(paper.id);
        }
      }

      if (deletedIds.length > 0) {
        result.push({ type: group.type, key: group.key, keptId: kept.id, deletedIds });
      }
    }

    return result;
  }

  /**
   * Return aggregate statistics about the local paper library.
   *
   * Useful for quick corpus overview before literature reviews or cleanup.
   */
  getLibraryStats(): {
    totalPapers: number;
    readStatusCounts: Record<string, number>;
    ratingDistribution: Record<number, number>;
    yearDistribution: Record<number, number>;
    tagDistribution: Record<string, number>;
    venueTopN: Array<{ venue: string; count: number }>;
    metadataCompleteness: {
      withDoi: number;
      withArxivId: number;
      withPdfText: number;
      withAbstract: number;
      withVenue: number;
    };
    duplicateGroupCount: number;
  } {
    const papers = this.getPapers();
    const readStatusCounts: Record<string, number> = {};
    const ratingDistribution: Record<number, number> = {};
    const yearDistribution: Record<number, number> = {};
    const tagDistribution: Record<string, number> = {};
    const venueCounts = new Map<string, number>();

    let withDoi = 0;
    let withArxivId = 0;
    let withPdfText = 0;
    let withAbstract = 0;
    let withVenue = 0;

    for (const paper of papers) {
      readStatusCounts[paper.readStatus] = (readStatusCounts[paper.readStatus] ?? 0) + 1;
      ratingDistribution[paper.rating] = (ratingDistribution[paper.rating] ?? 0) + 1;
      yearDistribution[paper.year] = (yearDistribution[paper.year] ?? 0) + 1;

      for (const tag of paper.tags) {
        const trimmed = tag.trim();
        if (trimmed) tagDistribution[trimmed] = (tagDistribution[trimmed] ?? 0) + 1;
      }

      const venue = paper.venue?.trim();
      if (venue) venueCounts.set(venue, (venueCounts.get(venue) ?? 0) + 1);

      if (paper.doi?.trim()) withDoi++;
      if (paper.arxivId?.trim()) withArxivId++;
      if (paper.pdfText && paper.pdfText.length > 50) withPdfText++;
      if (paper.abstract?.trim()) withAbstract++;
      if (venue) withVenue++;
    }

    const venueTopN = [...venueCounts.entries()]
      .map(([venue, count]) => ({ venue, count }))
      .sort((a, b) => b.count - a.count || a.venue.localeCompare(b.venue))
      .slice(0, 10);

    return {
      totalPapers: papers.length,
      readStatusCounts,
      ratingDistribution,
      yearDistribution,
      tagDistribution,
      venueTopN,
      metadataCompleteness: { withDoi, withArxivId, withPdfText, withAbstract, withVenue },
      duplicateGroupCount: this.findDuplicatePapers().length,
    };
  }

  /**
   * Export papers to BibTeX or JSON.
   *
   * If `paperIds` is omitted, all papers are exported. BibTeX keys are
   * generated from the first author's last name and year, with a numeric
   * suffix to avoid collisions.
   */
  exportPapers(format: 'bibtex' | 'json', paperIds?: string[]): {
    count: number;
    content: string;
  } {
    const papers = this.getPapers();
    const selected = paperIds && paperIds.length > 0
      ? papers.filter((p) => paperIds.includes(p.id))
      : papers;

    if (format === 'json') {
      return {
        count: selected.length,
        content: JSON.stringify(selected, null, 2),
      };
    }

    const usedKeys = new Set<string>();
    const entries: string[] = [];

    for (const paper of selected) {
      const key = this.generateBibtexKey(paper, usedKeys);
      usedKeys.add(key);

      const fields: Record<string, string> = {};
      fields.title = this.escapeBibtex(paper.title);
      if (paper.authors.length > 0) {
        fields.author = paper.authors.map((a) => this.escapeBibtex(a)).join(' and ');
      }
      fields.year = String(paper.year ?? '');
      if (paper.venue?.trim()) fields.journal = this.escapeBibtex(paper.venue);
      if (paper.doi?.trim()) fields.doi = paper.doi;
      if (paper.arxivId?.trim()) {
        fields.eprint = paper.arxivId;
        fields.archiveprefix = 'arXiv';
      }
      if (paper.pdfUrl?.trim()) fields.url = paper.pdfUrl;
      if (paper.abstract?.trim()) fields.abstract = this.escapeBibtex(paper.abstract);
      if (paper.tags.length > 0) fields.keywords = paper.tags.map((t) => this.escapeBibtex(t)).join(', ');

      const fieldLines = Object.entries(fields).map(([k, v]) => `  ${k} = {${v}},`);
      entries.push(`@article{${key},\n${fieldLines.join('\n')}\n}`);
    }

    return {
      count: selected.length,
      content: entries.join('\n\n'),
    };
  }

  private generateBibtexKey(paper: ReturnType<PersistenceStore['getPapers']>[number], usedKeys: Set<string>): string {
    const firstAuthor = paper.authors[0] ?? 'unknown';
    const lastName = firstAuthor.trim().split(/\s+/).pop() ?? 'unknown';
    const year = String(paper.year ?? 'noyear');
    const base = `${lastName.toLowerCase()}${year}`;
    if (!usedKeys.has(base)) return base;

    let suffix = 1;
    while (usedKeys.has(`${base}_${suffix}`)) suffix++;
    return `${base}_${suffix}`;
  }

  private escapeBibtex(value: string): string {
    return value
      .replace(/\\/g, '\\textbackslash{}')
      .replace(/\{/g, '\\{')
      .replace(/\}/g, '\\}')
      .replace(/\$/g, '\\$')
      .replace(/&/g, '\\&')
      .replace(/%/g, '\\%')
      .replace(/#/g, '\\#')
      .replace(/_/g, '\\_')
      .replace(/~/g, '\\textasciitilde{}')
      .replace(/\^/g, '\\textasciicircum{}');
  }

  /**
   * Import papers into the local library.
   *
   * `papers` should be normalized partial paper records. Existing papers are
   * skipped when a duplicate DOI, arXiv ID, or normalized title is already
   * present. Returns counts of imported and skipped items plus per-item status.
   */
  importPapers(papers: Array<{
    title: string;
    authors: string[];
    year: number;
    venue?: string;
    abstract?: string;
    doi?: string;
    arxivId?: string;
    pdfUrl?: string;
    tags?: string[];
  }>): {
    imported: number;
    skipped: number;
    total: number;
    items: Array<{ title: string; status: 'imported' | 'skipped'; reason?: string }>;
  } {
    const existing = this.getPapers();
    const existingDois = new Set(existing.map((p) => p.doi?.trim().toLowerCase()).filter(Boolean));
    const existingArxivIds = new Set(existing.map((p) => p.arxivId?.trim().toLowerCase()).filter(Boolean));
    const existingTitles = new Set(existing.map((p) => this.normalizeImportTitle(p.title)));

    const items: Array<{ title: string; status: 'imported' | 'skipped'; reason?: string }> = [];
    let imported = 0;
    let skipped = 0;

    for (const paper of papers) {
      const doi = paper.doi?.trim().toLowerCase();
      const arxivId = paper.arxivId?.trim().toLowerCase();
      const normalizedTitle = this.normalizeImportTitle(paper.title);

      if (doi && existingDois.has(doi)) {
        items.push({ title: paper.title, status: 'skipped', reason: `DOI ${paper.doi} already exists` });
        skipped++;
        continue;
      }
      if (arxivId && existingArxivIds.has(arxivId)) {
        items.push({ title: paper.title, status: 'skipped', reason: `arXiv ID ${paper.arxivId} already exists` });
        skipped++;
        continue;
      }
      if (normalizedTitle.length > 5 && existingTitles.has(normalizedTitle)) {
        items.push({ title: paper.title, status: 'skipped', reason: 'Normalized title already exists' });
        skipped++;
        continue;
      }

      const id = `paper-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      this.savePaper({
        id,
        title: paper.title,
        authors: paper.authors,
        year: paper.year,
        venue: paper.venue ?? '',
        abstract: paper.abstract ?? '',
        doi: paper.doi,
        arxivId: paper.arxivId,
        pdfUrl: paper.pdfUrl,
        tags: paper.tags ?? [],
        notes: '',
        readStatus: 'unread',
        rating: 0,
        addedAt: Date.now(),
      });

      if (doi) existingDois.add(doi);
      if (arxivId) existingArxivIds.add(arxivId);
      if (normalizedTitle.length > 5) existingTitles.add(normalizedTitle);

      items.push({ title: paper.title, status: 'imported' });
      imported++;
    }

    return { imported, skipped, total: papers.length, items };
  }

  private normalizeImportTitle(title: string): string {
    return title.toLowerCase().replace(/[^a-z0-9\u4e00-\u9fa5]/g, '').trim();
  }

  /**
   * Return aggregate statistics about tracked experiments.
   */
  getExperimentStats(): {
    totalExperiments: number;
    statusCounts: Record<string, number>;
    withScript: number;
    withoutScript: number;
    tagDistribution: Record<string, number>;
    metricKeys: string[];
    recentlyUpdated: Array<{ id: string; name: string; status: string; updatedAt: number }>;
  } {
    const experiments = this.getExperiments();
    const statusCounts: Record<string, number> = {};
    const tagDistribution: Record<string, number> = {};
    const metricKeys = new Set<string>();
    let withScript = 0;

    for (const exp of experiments) {
      statusCounts[exp.status] = (statusCounts[exp.status] ?? 0) + 1;
      if (exp.scriptPath?.trim()) withScript++;

      for (const tag of exp.tags) {
        const trimmed = tag.trim();
        if (trimmed) tagDistribution[trimmed] = (tagDistribution[trimmed] ?? 0) + 1;
      }

      for (const key of Object.keys(exp.metrics)) {
        metricKeys.add(key);
      }
    }

    const recentlyUpdated = [...experiments]
      .sort((a, b) => b.createdAt - a.createdAt)
      .slice(0, 5)
      .map((exp) => ({ id: exp.id, name: exp.name, status: exp.status, updatedAt: exp.createdAt }));

    return {
      totalExperiments: experiments.length,
      statusCounts,
      withScript,
      withoutScript: experiments.length - withScript,
      tagDistribution,
      metricKeys: [...metricKeys].sort(),
      recentlyUpdated,
    };
  }

  /**
   * Compare a set of experiments by parameters and metrics.
   *
   * Returns the experiments, the union of parameter keys, the union of metric
   * keys, and which keys vary across the selected experiments.
   */
  compareExperiments(ids: string[]): {
    experiments: ReturnType<PersistenceStore['getExperiments']>;
    parameterKeys: string[];
    metricKeys: string[];
    varyingParameters: string[];
    varyingMetrics: string[];
  } {
    const allExperiments = this.getExperiments();
    const selected = ids
      .map((id) => allExperiments.find((e) => e.id === id))
      .filter((e): e is NonNullable<typeof e> => e !== undefined);

    const parameterKeys = new Set<string>();
    const metricKeys = new Set<string>();

    for (const exp of selected) {
      for (const key of Object.keys(exp.parameters)) parameterKeys.add(key);
      for (const key of Object.keys(exp.metrics)) metricKeys.add(key);
    }

    const varyingParameters = [...parameterKeys].filter((key) => {
      const values = selected.map((e) => e.parameters[key]);
      return new Set(values).size > 1;
    });

    const varyingMetrics = [...metricKeys].filter((key) => {
      const values = selected.map((e) => e.metrics[key]);
      return new Set(values).size > 1;
    });

    return {
      experiments: selected,
      parameterKeys: [...parameterKeys].sort(),
      metricKeys: [...metricKeys].sort(),
      varyingParameters: varyingParameters.sort(),
      varyingMetrics: varyingMetrics.sort(),
    };
  }

  /**
   * Export experiments to JSON. If `ids` is omitted, all experiments are exported.
   */
  exportExperiments(ids?: string[]): { count: number; content: string } {
    const experiments = this.getExperiments();
    const selected = ids && ids.length > 0
      ? experiments.filter((e) => ids.includes(e.id))
      : experiments;

    return {
      count: selected.length,
      content: JSON.stringify(selected, null, 2),
    };
  }

  /**
   * Return aggregate statistics about local collections.
   */
  getCollectionStats(): {
    totalCollections: number;
    totalPapersInCollections: number;
    emptyCollections: number;
    collections: Array<{ id: string; name: string; paperCount: number; paperIds: string[] }>;
  } {
    const collections = this.getCollections();
    const papers = this.getPapers();
    const paperMap = new Map(papers.map((p) => [p.id, p]));

    let totalPapersInCollections = 0;
    let emptyCollections = 0;

    const collectionDetails = collections.map((collection) => {
      const validPaperIds = collection.paperIds.filter((id) => paperMap.has(id));
      const paperCount = validPaperIds.length;
      totalPapersInCollections += paperCount;
      if (paperCount === 0) emptyCollections++;

      return {
        id: collection.id,
        name: collection.name,
        paperCount,
        paperIds: validPaperIds,
      };
    });

    return {
      totalCollections: collections.length,
      totalPapersInCollections,
      emptyCollections,
      collections: collectionDetails,
    };
  }

  /**
   * Audit tag consistency across papers, notes, and experiments.
   */
  auditTags(): {
    totalUniqueTags: number;
    tagCounts: Record<string, number>;
    emptyTags: number;
    caseConflicts: Array<{ canonical: string; variants: string[] }>;
    similarTags: Array<{ tagA: string; tagB: string; reason: string }>;
    tagsByType: { papers: Record<string, number>; notes: Record<string, number>; experiments: Record<string, number> };
  } {
    const papers = this.getPapers();
    const notes = this.getNotes();
    const experiments = this.getExperiments();

    const tagCounts: Record<string, number> = {};
    const tagsByType = {
      papers: {} as Record<string, number>,
      notes: {} as Record<string, number>,
      experiments: {} as Record<string, number>,
    };
    let emptyTags = 0;

    function record(tags: string[], bucket: Record<string, number>) {
      for (const tag of tags) {
        const trimmed = tag.trim();
        if (!trimmed) {
          emptyTags++;
          continue;
        }
        tagCounts[trimmed] = (tagCounts[trimmed] ?? 0) + 1;
        bucket[trimmed] = (bucket[trimmed] ?? 0) + 1;
      }
    }

    for (const paper of papers) record(paper.tags, tagsByType.papers);
    for (const note of notes) record(note.tags, tagsByType.notes);
    for (const experiment of experiments) record(experiment.tags, tagsByType.experiments);

    const canonicalMap = new Map<string, string[]>();
    for (const tag of Object.keys(tagCounts)) {
      const lower = tag.toLowerCase();
      const group = canonicalMap.get(lower) ?? [];
      group.push(tag);
      canonicalMap.set(lower, group);
    }

    const caseConflicts: Array<{ canonical: string; variants: string[] }> = [];
    for (const [lower, variants] of canonicalMap.entries()) {
      if (variants.length > 1) {
        caseConflicts.push({ canonical: lower, variants: variants.sort() });
      }
    }

    const similarTags: Array<{ tagA: string; tagB: string; reason: string }> = [];
    const sortedTags = Object.keys(tagCounts).sort();
    for (let i = 0; i < sortedTags.length; i++) {
      for (let j = i + 1; j < sortedTags.length; j++) {
        const a = sortedTags[i]!;
        const b = sortedTags[j]!;
        if (a.toLowerCase() === b.toLowerCase()) continue; // already covered by case conflicts

        const normalizedA = a.toLowerCase().replace(/[-_\s]/g, '');
        const normalizedB = b.toLowerCase().replace(/[-_\s]/g, '');
        if (normalizedA === normalizedB) {
          similarTags.push({ tagA: a, tagB: b, reason: 'Same letters ignoring separators' });
        } else if (this.levenshteinDistance(normalizedA, normalizedB) === 1 && Math.max(normalizedA.length, normalizedB.length) > 3) {
          similarTags.push({ tagA: a, tagB: b, reason: 'Single-character edit distance' });
        }
      }
    }

    return {
      totalUniqueTags: Object.keys(tagCounts).length,
      tagCounts,
      emptyTags,
      caseConflicts,
      similarTags,
      tagsByType,
    };
  }

  private levenshteinDistance(a: string, b: string): number {
    const matrix: number[][] = Array.from({ length: a.length + 1 }, (_, i) =>
      Array.from({ length: b.length + 1 }, (_, j) => (i === 0 ? j : j === 0 ? i : 0)),
    );

    for (let i = 1; i <= a.length; i++) {
      for (let j = 1; j <= b.length; j++) {
        const cost = a[i - 1] === b[j - 1] ? 0 : 1;
        matrix[i]![j] = Math.min(
          matrix[i - 1]![j]! + 1,
          matrix[i]![j - 1]! + 1,
          matrix[i - 1]![j - 1]! + cost,
        );
      }
    }

    return matrix[a.length]![b.length]!;
  }

  /**
   * Merge (rename/deduplicate) tags across papers, notes, and experiments.
   * `mapping` maps source tags to target tags. When a target tag already exists
   * on an entity, the source tag is simply removed.
   */
  mergeTags(
    mapping: Record<string, string>,
    dryRun = false,
  ): {
    merged: number;
    papersUpdated: number;
    notesUpdated: number;
    experimentsUpdated: number;
    details: Array<{
      entityType: 'paper' | 'note' | 'experiment';
      entityId: string;
      oldTags: string[];
      newTags: string[];
    }>;
  } {
    const normalized: Record<string, string> = {};
    for (const [source, target] of Object.entries(mapping)) {
      const s = source.trim();
      const t = target.trim();
      if (!s || s === t) continue;
      normalized[s] = t;
    }

    let merged = 0;
    let papersUpdated = 0;
    let notesUpdated = 0;
    let experimentsUpdated = 0;
    const details: Array<{
      entityType: 'paper' | 'note' | 'experiment';
      entityId: string;
      oldTags: string[];
      newTags: string[];
    }> = [];

    function applyTags(oldTags: string[]): { changed: boolean; newTags: string[] } {
      const seen = new Set<string>();
      const newTags: string[] = [];
      let changed = false;
      for (const tag of oldTags) {
        const trimmed = tag.trim();
        if (!trimmed) continue;
        const replacement = normalized[trimmed] ?? trimmed;
        if (replacement !== trimmed) {
          changed = true;
        }
        if (!seen.has(replacement)) {
          seen.add(replacement);
          newTags.push(replacement);
        } else if (replacement !== trimmed) {
          // source was folded into an existing target; already counted as changed
          changed = true;
        }
      }
      return { changed, newTags };
    }

    const papers = this.getPapers();
    for (const paper of papers) {
      const { changed, newTags } = applyTags(paper.tags);
      if (changed) {
        merged++;
        papersUpdated++;
        details.push({ entityType: 'paper', entityId: paper.id, oldTags: paper.tags, newTags });
        if (!dryRun) {
          this.savePaper({ ...paper, tags: newTags });
        }
      }
    }

    const notes = this.getNotes();
    for (const note of notes) {
      const { changed, newTags } = applyTags(note.tags);
      if (changed) {
        merged++;
        notesUpdated++;
        details.push({ entityType: 'note', entityId: note.id, oldTags: note.tags, newTags });
        if (!dryRun) {
          this.saveNote({ ...note, tags: newTags });
        }
      }
    }

    const experiments = this.getExperiments();
    for (const experiment of experiments) {
      const { changed, newTags } = applyTags(experiment.tags);
      if (changed) {
        merged++;
        experimentsUpdated++;
        details.push({ entityType: 'experiment', entityId: experiment.id, oldTags: experiment.tags, newTags });
        if (!dryRun) {
          this.saveExperiment({ ...experiment, tags: newTags });
        }
      }
    }

    return { merged, papersUpdated, notesUpdated, experimentsUpdated, details };
  }

  /**
   * Build a local paper association network from shared tags, shared authors,
   * and collection co-occurrence. Edges are weighted by the number of shared
   * dimensions. This is a local similarity network rather than a true citation
   * graph, which would require parsed reference lists.
   */
  getLocalPaperNetwork(options: {
    minWeight?: number;
    includeSharedTags?: boolean;
    includeSharedAuthors?: boolean;
    includeCollectionCooccurrence?: boolean;
  } = {}): {
    nodeCount: number;
    edgeCount: number;
    isolatedNodes: string[];
    components: Array<{ nodes: string[]; size: number }>;
    topNodes: Array<{ id: string; title: string; degree: number; weightedDegree: number }>;
    edges: Array<{ source: string; target: string; weight: number; reasons: string[] }>;
  } {
    const {
      minWeight = 0,
      includeSharedTags = true,
      includeSharedAuthors = true,
      includeCollectionCooccurrence = true,
    } = options;

    const papers = this.getPapers();
    const collections = this.getCollections();
    const paperIds = papers.map((p) => p.id);
    const indexById = new Map(papers.map((p, i) => [p.id, i]));

    // Pre-compute collection membership for fast lookup
    const paperCollections = new Map<string, Set<string>>();
    for (const collection of collections) {
      for (const paperId of collection.paperIds) {
        if (!paperCollections.has(paperId)) {
          paperCollections.set(paperId, new Set<string>());
        }
        paperCollections.get(paperId)!.add(collection.id);
      }
    }

    const edges: Array<{ source: string; target: string; weight: number; reasons: string[] }> = [];

    for (let i = 0; i < papers.length; i++) {
      for (let j = i + 1; j < papers.length; j++) {
        const a = papers[i]!;
        const b = papers[j]!;
        const reasons: string[] = [];
        let weight = 0;

        if (includeSharedTags) {
          const sharedTags = a.tags.filter((t) => b.tags.includes(t));
          if (sharedTags.length > 0) {
            weight += sharedTags.length;
            reasons.push(`shared tags: ${sharedTags.join(', ')}`);
          }
        }

        if (includeSharedAuthors) {
          const sharedAuthors = a.authors.filter((auth) => b.authors.includes(auth));
          if (sharedAuthors.length > 0) {
            weight += sharedAuthors.length;
            reasons.push(`shared authors: ${sharedAuthors.join(', ')}`);
          }
        }

        if (includeCollectionCooccurrence) {
          const aCols = paperCollections.get(a.id) ?? new Set<string>();
          const bCols = paperCollections.get(b.id) ?? new Set<string>();
          const sharedCols = [...aCols].filter((c) => bCols.has(c));
          if (sharedCols.length > 0) {
            weight += sharedCols.length;
            reasons.push(`shared collections: ${sharedCols.length}`);
          }
        }

        if (weight > 0 && weight >= minWeight) {
          edges.push({ source: a.id, target: b.id, weight, reasons });
        }
      }
    }

    // Degree and weighted degree
    const degree = new Map<string, number>();
    const weightedDegree = new Map<string, number>();
    for (const id of paperIds) {
      degree.set(id, 0);
      weightedDegree.set(id, 0);
    }
    for (const edge of edges) {
      degree.set(edge.source, (degree.get(edge.source) ?? 0) + 1);
      degree.set(edge.target, (degree.get(edge.target) ?? 0) + 1);
      weightedDegree.set(edge.source, (weightedDegree.get(edge.source) ?? 0) + edge.weight);
      weightedDegree.set(edge.target, (weightedDegree.get(edge.target) ?? 0) + edge.weight);
    }

    // Union-find for connected components
    const parent = new Map<number, number>(paperIds.map((_, i) => [i, i]));
    function find(x: number): number {
      let current = parent.get(x)!;
      while (current !== parent.get(current)) {
        const next = parent.get(current)!;
        parent.set(current, parent.get(next)!);
        current = next;
      }
      return current;
    }
    function union(x: number, y: number): void {
      const rx = find(x);
      const ry = find(y);
      if (rx !== ry) parent.set(rx, ry);
    }
    for (const edge of edges) {
      union(indexById.get(edge.source)!, indexById.get(edge.target)!);
    }

    const componentMap = new Map<number, string[]>();
    for (const id of paperIds) {
      const root = find(indexById.get(id)!);
      const group = componentMap.get(root) ?? [];
      group.push(id);
      componentMap.set(root, group);
    }
    const components = [...componentMap.values()]
      .map((nodes) => ({ nodes, size: nodes.length }))
      .sort((a, b) => b.size - a.size);

    const isolatedNodes = paperIds.filter((id) => (degree.get(id) ?? 0) === 0);

    const topNodes = paperIds
      .map((id) => {
        const paper = papers[indexById.get(id)!]!;
        return {
          id,
          title: paper.title,
          degree: degree.get(id) ?? 0,
          weightedDegree: weightedDegree.get(id) ?? 0,
        };
      })
      .sort((a, b) => b.weightedDegree - a.weightedDegree || b.degree - a.degree)
      .slice(0, 10);

    return {
      nodeCount: papers.length,
      edgeCount: edges.length,
      isolatedNodes,
      components,
      topNodes,
      edges: edges.sort((a, b) => b.weight - a.weight),
    };
  }

  /**
   * Build a structured literature triage matrix for a set of papers.
   *
   * Inspired by the `literature-triage-matrix` skill (WenyuChiou/ai-research-skills),
   * adapted to Metis's local library. For each paper we extract a compact
   * 9-column comparison that a researcher can scan at a glance:
   *
   *   citation | question | method | data | claim | evidence_type |
   *   limitation | relevance | where_to_use
   *
   * Columns are filled heuristically from title/abstract/tags/rating.
   * `limitation` and `where_to_use` are intentionally left as actionable
   * placeholders ("requires analysis") because they need close reading or
   * LLM reasoning that the tool should not fabricate.
   *
   * Added round 304.
   */
  triageLiterature(options: {
    paperIds?: string[];
    query?: string;
    limit?: number;
  } = {}): {
    papersAnalyzed: number;
    queryUsed: string | null;
    matrix: Array<{
      id: string;
      citation: string;
      question: string;
      method: string;
      data: string;
      claim: string;
      evidenceType: 'empirical' | 'theoretical' | 'mixed' | 'unknown';
      limitation: string;
      relevance: number;
      whereToUse: string;
    }>;
  } {
    const { paperIds, query, limit = 10 } = options;
    let papers = this.getPapers();

    if (paperIds && paperIds.length > 0) {
      const wanted = new Set(paperIds);
      papers = papers.filter((p) => wanted.has(p.id));
    }

    const normalizedQuery = query ? query.toLowerCase().trim() : '';
    if (normalizedQuery) {
      const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
      papers = papers
        .map((p) => {
          const haystack = [
            p.title,
            p.abstract,
            (p.tags ?? []).join(' '),
            (p.authors ?? []).join(' '),
            p.notes ?? '',
          ]
            .join(' ')
            .toLowerCase();
          const hits = queryTerms.filter((t) => haystack.includes(t)).length;
          return { paper: p, hits };
        })
        .filter((e) => e.hits > 0)
        .sort((a, b) => b.hits - a.hits)
        .map((e) => e.paper);
    }

    papers = papers.slice(0, Math.max(1, Math.min(limit, 50)));

    const matrix = papers.map((p) => {
      const abstract = (p.abstract ?? '').trim();
      const sentences = splitIntoSentences(abstract);

      const citation = formatPaperCitation(p);
      const question = extractFirstSentence(sentences) || truncate(p.title, 140);
      const method = findSentenceWithKeywords(sentences, [
        'we propose', 'we present', 'we introduce', 'our method', 'our approach',
        'we design', 'we develop', 'we build', 'we train',
        'algorithm', 'framework', 'architecture', 'pipeline',
      ]) || 'not stated in abstract';
      const data = findSentenceWithKeywords(sentences, [
        'dataset', 'corpus', 'benchmark', 'data', 'samples', 'participants',
        'subjects', 'images', 'documents', 'tokens',
      ]) || 'not stated in abstract';
      const claim = findSentenceWithKeywords(sentences, [
        'we show', 'we demonstrate', 'we find', 'we achieve', 'results show',
        'results indicate', 'outperform', 'improve', 'achieve', 'state-of-the-art',
      ]) || 'not stated in abstract';

      const evidenceType = classifyEvidence(abstract);
      const limitation = 'requires analysis';
      const whereToUse = 'requires analysis';

      // Relevance: 0–1. Base on rating (0–5 → 0–0.5) plus tag/term overlap
      // with the query (0–0.5) so a query can surface the most on-topic papers.
      let relevance = Math.min(0.5, (p.rating ?? 0) / 10);
      if (normalizedQuery) {
        const haystack = `${p.title} ${abstract} ${(p.tags ?? []).join(' ')}`.toLowerCase();
        const queryTerms = normalizedQuery.split(/\s+/).filter(Boolean);
        const overlap = queryTerms.filter((t) => haystack.includes(t)).length;
        relevance += Math.min(0.5, (overlap / Math.max(1, queryTerms.length)) * 0.5);
      } else {
        relevance += 0.25; // no query: give a neutral baseline so relevance stays meaningful
      }

      return {
        id: p.id,
        citation,
        question,
        method,
        data,
        claim,
        evidenceType,
        limitation,
        relevance: Number(relevance.toFixed(2)),
        whereToUse,
      };
    });

    return {
      papersAnalyzed: matrix.length,
      queryUsed: normalizedQuery || null,
      matrix,
    };
  }

  /**
   * Build an interest profile from the local library: the user's preferred
   * topics (tags), authors, venues, year/recency window, and how they rate
   * papers by tag. This is the foundation for research-assist-style candidate
   * ranking (profile a user from their local library history, then score
   * candidate papers against the profile).
   *
   * Added round 307.
   */
  buildInterestProfile(options: { minWeight?: number; topN?: number } = {}): {
    paperCount: number;
    topTags: Array<{ tag: string; count: number; avgRating: number }>;
    topAuthors: Array<{ author: string; count: number }>;
    topVenues: Array<{ venue: string; count: number }>;
    yearRange: { earliest: number | null; latest: number | null; medianYear: number | null };
    readRatio: number;
    avgRating: number;
    recencyBias: { since2020Ratio: number; medianRecencyWeight: number };
    topCollections: Array<{ name: string; paperCount: number }>;
  } {
    const { topN = 10 } = options;
    const papers = this.getPapers();
    const collections = this.getCollections();

    if (papers.length === 0) {
      return {
        paperCount: 0,
        topTags: [],
        topAuthors: [],
        topVenues: [],
        yearRange: { earliest: null, latest: null, medianYear: null },
        readRatio: 0,
        avgRating: 0,
        recencyBias: { since2020Ratio: 0, medianRecencyWeight: 0 },
        topCollections: [],
      };
    }

    // Tag aggregation with average rating per tag.
    const tagStats = new Map<string, { count: number; ratingSum: number }>();
    for (const p of papers) {
      for (const tag of p.tags ?? []) {
        const norm = tag.toLowerCase().trim();
        if (!norm) continue;
        const cur = tagStats.get(norm) ?? { count: 0, ratingSum: 0 };
        cur.count += 1;
        cur.ratingSum += p.rating ?? 0;
        tagStats.set(norm, cur);
      }
    }
    const topTags = [...tagStats.entries()]
      .map(([tag, s]) => ({ tag, count: s.count, avgRating: Number((s.ratingSum / s.count).toFixed(2)) }))
      .sort((a, b) => b.count - a.count || b.avgRating - a.avgRating)
      .slice(0, topN);

    // Author aggregation.
    const authorCounts = new Map<string, number>();
    for (const p of papers) {
      for (const author of p.authors ?? []) {
        const norm = author.toLowerCase().trim();
        if (!norm) continue;
        authorCounts.set(norm, (authorCounts.get(norm) ?? 0) + 1);
      }
    }
    const topAuthors = [...authorCounts.entries()]
      .map(([author, count]) => ({ author, count }))
      .sort((a, b) => b.count - a.count || a.author.localeCompare(b.author))
      .slice(0, topN);

    // Venue aggregation.
    const venueCounts = new Map<string, number>();
    for (const p of papers) {
      const v = (p.venue ?? '').trim();
      if (!v) continue;
      venueCounts.set(v, (venueCounts.get(v) ?? 0) + 1);
    }
    const topVenues = [...venueCounts.entries()]
      .map(([venue, count]) => ({ venue, count }))
      .sort((a, b) => b.count - a.count || a.venue.localeCompare(b.venue))
      .slice(0, topN);

    // Year range + median.
    const years = papers.map((p) => p.year).filter((y) => typeof y === 'number') as number[];
    years.sort((a, b) => a - b);
    const earliest = years.length > 0 ? years[0]! : null;
    const latest = years.length > 0 ? years[years.length - 1]! : null;
    const medianYear = years.length > 0 ? years[Math.floor(years.length / 2)]! : null;

    // Read ratio + average rating.
    const readCount = papers.filter((p) => p.readStatus === 'read').length;
    const readRatio = Number((readCount / papers.length).toFixed(2));
    const ratingSum = papers.reduce((acc, p) => acc + (p.rating ?? 0), 0);
    const avgRating = Number((ratingSum / papers.length).toFixed(2));

    // Recency bias — Consensus/research-assist style: weight recent evidence higher.
    const since2020 = papers.filter((p) => typeof p.year === 'number' && p.year >= 2020).length;
    const since2020Ratio = Number((since2020 / papers.length).toFixed(2));
    // medianRecencyWeight: 1.0 if all papers are current year, decaying toward 0.
    const currentYear = new Date().getFullYear();
    const medianAge = medianYear !== null ? Math.max(0, currentYear - medianYear) : 0;
    const medianRecencyWeight = Number(Math.max(0, 1 - medianAge / 10).toFixed(2));

    // Top collections by paper count.
    const topCollections = collections
      .map((c) => ({ name: c.name, paperCount: c.paperIds.length }))
      .sort((a, b) => b.paperCount - a.paperCount || a.name.localeCompare(b.name))
      .slice(0, topN);

    return {
      paperCount: papers.length,
      topTags,
      topAuthors,
      topVenues,
      yearRange: { earliest, latest, medianYear },
      readRatio,
      avgRating,
      recencyBias: { since2020Ratio, medianRecencyWeight },
      topCollections,
    };
  }

  /**
   * Rank a set of candidate papers against the local interest profile.
   *
   * Scoring (each dimension contributes 0–0.2, total 0–1):
   *   - tagOverlap: fraction of the candidate's tags that appear in the
   *     profile's top tags (weighted by profile tag count).
   *   - authorOverlap: does the candidate share any top-profile author.
   *   - venueMatch: is the candidate's venue a top-profile venue.
   *   - recency: how close the candidate's year is to the profile median year
   *     (within 5 years = full; decays to 0 at 15 years).
   *   - ratingSignal: the candidate's own rating, normalized to 0–5.
   *
   * Pass paperIds to rank a specific set, or a query to filter the local
   * library; otherwise all papers are ranked (useful for surfacing which
   * already-owned papers best match the user's interests).
   *
   * Added round 308.
   */
  rankCandidates(options: {
    paperIds?: string[];
    query?: string;
    limit?: number;
  } = {}): {
    profilePaperCount: number;
    ranked: Array<{
      id: string;
      title: string;
      score: number;
      dimensions: {
        tagOverlap: number;
        authorOverlap: number;
        venueMatch: number;
        recency: number;
        ratingSignal: number;
      };
      matchedTags: string[];
      matchedAuthors: string[];
    }>;
  } {
    const { paperIds, query, limit = 20 } = options;
    const profile = this.buildInterestProfile({ topN: 8 });

    let papers = this.getPapers();
    if (paperIds && paperIds.length > 0) {
      const wanted = new Set(paperIds);
      papers = papers.filter((p) => wanted.has(p.id));
    }
    const normalizedQuery = query ? query.toLowerCase().trim() : '';
    if (normalizedQuery) {
      const terms = normalizedQuery.split(/\s+/).filter(Boolean);
      papers = papers
        .map((p) => {
          const haystack = `${p.title} ${p.abstract} ${(p.tags ?? []).join(' ')}`.toLowerCase();
          const hits = terms.filter((t) => haystack.includes(t)).length;
          return { paper: p, hits };
        })
        .filter((e) => e.hits > 0)
        .map((e) => e.paper);
    }

    const topTagSet = new Set(profile.topTags.map((t) => t.tag));
    const topTagWeights = new Map(profile.topTags.map((t) => [t.tag, t.count]));
    const topAuthorSet = new Set(profile.topAuthors.map((a) => a.author));
    const topVenueWeights = new Map(profile.topVenues.map((v) => [v.venue.toLowerCase(), v.count]));
    const maxVenueWeight = Math.max(1, ...topVenueWeights.values());
    const medianYear = profile.yearRange.medianYear;
    const maxTagWeight = Math.max(1, ...topTagWeights.values());

    const ranked = papers.map((p) => {
      const tags = (p.tags ?? []).map((t) => t.toLowerCase().trim()).filter(Boolean);
      const matchedTags = tags.filter((t) => topTagSet.has(t));
      const tagWeightSum = matchedTags.reduce((acc, t) => acc + (topTagWeights.get(t) ?? 0), 0);
      const tagOverlap = tags.length > 0 ? Math.min(1, tagWeightSum / (maxTagWeight * Math.max(1, tags.length))) : 0;

      const authors = (p.authors ?? []).map((a) => a.toLowerCase().trim()).filter(Boolean);
      const matchedAuthors = authors.filter((a) => topAuthorSet.has(a));
      const authorOverlap = authors.length > 0 ? Math.min(1, matchedAuthors.length / authors.length) : 0;

      // venueMatch: only count venues that appear at least twice in the
      // library (single-occurrence venues are noise, not preference). Then
      // scale by the max weight so the most-frequent venue scores 1.0.
      const venueWeight = p.venue ? (topVenueWeights.get(p.venue.toLowerCase()) ?? 0) : 0;
      const venueMatch = venueWeight >= 2 ? Number((venueWeight / maxVenueWeight).toFixed(2)) : 0;

      let recency = 0;
      if (typeof p.year === 'number' && medianYear !== null) {
        const distance = Math.abs(p.year - medianYear);
        recency = distance <= 5 ? 1 : Math.max(0, 1 - (distance - 5) / 10);
      }

      const ratingSignal = Math.min(1, (p.rating ?? 0) / 5);

      const score = Number((
        tagOverlap * 0.35 +
        authorOverlap * 0.15 +
        venueMatch * 0.1 +
        recency * 0.2 +
        ratingSignal * 0.2
      ).toFixed(3));

      return {
        id: p.id,
        title: p.title,
        score,
        dimensions: {
          tagOverlap: Number(tagOverlap.toFixed(2)),
          authorOverlap: Number(authorOverlap.toFixed(2)),
          venueMatch,
          recency: Number(recency.toFixed(2)),
          ratingSignal: Number(ratingSignal.toFixed(2)),
        },
        matchedTags,
        matchedAuthors,
      };
    });

    ranked.sort((a, b) => b.score - a.score);

    return {
      profilePaperCount: profile.paperCount,
      ranked: ranked.slice(0, Math.max(1, Math.min(limit, 100))),
    };
  }

  /**
   * Full-text search across local papers. Searches title, authors,
   * abstract, extracted PDF text, and notes. Supports simple inclusion
   * terms and exclusion terms prefixed with '-'.
   */
  fullTextSearch(
    query: string,
    options: { limit?: number; includeSnippet?: boolean } = {},
  ): Array<{
    paper: ReturnType<PersistenceStore['getPapers']>[number];
    score: number;
    matchedFields: string[];
    snippet?: string;
  }> {
    const { limit = 20, includeSnippet = true } = options;
    const rawTerms = query
      .toLowerCase()
      .replace(/[^a-z0-9\s\-"]/g, ' ')
      .split(/\s+/)
      .filter(Boolean);

    const phrases: string[] = [];
    const includeTerms: string[] = [];
    const excludeTerms: string[] = [];

    let i = 0;
    while (i < rawTerms.length) {
      const term = rawTerms[i]!;
      if (term.startsWith('"')) {
        const phraseParts: string[] = [term.replace(/^"/, '')];
        i++;
        while (i < rawTerms.length && !rawTerms[i]!.endsWith('"')) {
          phraseParts.push(rawTerms[i]!);
          i++;
        }
        if (i < rawTerms.length) {
          phraseParts.push(rawTerms[i]!.replace(/"$/, ''));
          i++;
        }
        const phrase = phraseParts.join(' ').trim();
        if (phrase) phrases.push(phrase);
      } else if (term.startsWith('-') && term.length > 1) {
        excludeTerms.push(term.slice(1));
        i++;
      } else {
        includeTerms.push(term);
        i++;
      }
    }

    if (includeTerms.length === 0 && phrases.length === 0) {
      return [];
    }

    const papers = this.getPapers();
    const fieldWeights: Array<{ name: string; text: (p: typeof papers[number]) => string; weight: number }> = [
      { name: 'title', text: (p) => p.title, weight: 10 },
      { name: 'authors', text: (p) => p.authors.join(' '), weight: 5 },
      { name: 'abstract', text: (p) => p.abstract, weight: 4 },
      { name: 'pdfText', text: (p) => p.pdfText ?? '', weight: 2 },
      { name: 'notes', text: (p) => p.notes, weight: 3 },
    ];

    function countOccurrences(haystack: string, needles: string[]): number {
      const normalizedHaystack = haystack.toLowerCase();
      let count = 0;
      for (const needle of needles) {
        let pos = 0;
        while ((pos = normalizedHaystack.indexOf(needle, pos)) !== -1) {
          count++;
          pos += needle.length;
        }
      }
      for (const phrase of phrases) {
        let pos = 0;
        while ((pos = normalizedHaystack.indexOf(phrase, pos)) !== -1) {
          count += 3;
          pos += phrase.length;
        }
      }
      return count;
    }

    function containsAny(haystack: string, needles: string[]): boolean {
      const normalized = haystack.toLowerCase();
      return needles.some((n) => normalized.includes(n)) || phrases.some((p) => normalized.includes(p));
    }

    function containsAll(haystack: string, needles: string[]): boolean {
      const normalized = haystack.toLowerCase();
      return needles.every((n) => normalized.includes(n)) && phrases.every((p) => normalized.includes(p));
    }

    const results = [];
    for (const paper of papers) {
      const fullText = fieldWeights.map((f) => f.text(paper)).join('\n');

      if (excludeTerms.length > 0 && containsAny(fullText, excludeTerms)) {
        continue;
      }

      const allRequired = [...includeTerms, ...phrases];
      if (allRequired.length > 0 && !containsAll(fullText, allRequired)) {
        continue;
      }

      let score = 0;
      const matchedFields: string[] = [];
      for (const field of fieldWeights) {
        const text = field.text(paper);
        const occurrences = countOccurrences(text, includeTerms);
        if (occurrences > 0) {
          score += occurrences * field.weight;
          if (!matchedFields.includes(field.name)) {
            matchedFields.push(field.name);
          }
        }
      }

      if (score === 0) continue;

      let snippet: string | undefined;
      if (includeSnippet) {
        const haystack = fullText.toLowerCase();
        const firstTerm = includeTerms[0] ?? phrases[0] ?? '';
        const pos = haystack.indexOf(firstTerm);
        if (pos !== -1) {
          const start = Math.max(0, pos - 80);
          const end = Math.min(fullText.length, pos + firstTerm.length + 120);
          snippet = (start > 0 ? '...' : '') + fullText.slice(start, end) + (end < fullText.length ? '...' : '');
        }
      }

      results.push({ paper, score, matchedFields, snippet });
    }

    return results
      .sort((a, b) => b.score - a.score)
      .slice(0, limit);
  }

  /**
   * Return aggregate statistics about local notes.
   */
  getNoteStats(): {
    totalNotes: number;
    totalLinkedPapers: number;
    totalLinkedNotes: number;
    orphanNotes: number;
    tagDistribution: Record<string, number>;
    recentlyUpdated: Array<{ id: string; title: string; updatedAt: number }>;
  } {
    const notes = this.getNotes();
    const papers = this.getPapers();
    const paperIds = new Set(papers.map((p) => p.id));

    const tagDistribution: Record<string, number> = {};
    let totalLinkedPapers = 0;
    let totalLinkedNotes = 0;
    let orphanNotes = 0;

    for (const note of notes) {
      const validLinkedPapers = note.linkedPaperIds.filter((id) => paperIds.has(id));
      totalLinkedPapers += validLinkedPapers.length;
      totalLinkedNotes += note.linkedNoteIds.length;

      if (validLinkedPapers.length === 0 && note.linkedNoteIds.length === 0) {
        orphanNotes++;
      }

      for (const tag of note.tags) {
        const trimmed = tag.trim();
        if (trimmed) tagDistribution[trimmed] = (tagDistribution[trimmed] ?? 0) + 1;
      }
    }

    const recentlyUpdated = [...notes]
      .sort((a, b) => b.updatedAt - a.updatedAt)
      .slice(0, 5)
      .map((note) => ({ id: note.id, title: note.title, updatedAt: note.updatedAt }));

    return {
      totalNotes: notes.length,
      totalLinkedPapers,
      totalLinkedNotes,
      orphanNotes,
      tagDistribution,
      recentlyUpdated,
    };
  }

  // ─── Collections ──────────────────────────────────────────────

  saveCollection(collection: {
    id: string; name: string; description: string; paperIds: string[]; createdAt: number;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO collections
       (id, name, description, paper_ids, created_at)
       VALUES (?, ?, ?, ?, ?)`,
    ).run(
      collection.id, collection.name, collection.description,
      JSON.stringify(collection.paperIds), collection.createdAt,
    );
  }

  getCollections(): Array<{
    id: string; name: string; description: string; paperIds: string[]; createdAt: number;
  }> {
    const rows = this.db.prepare('SELECT * FROM collections ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      paperIds: JSON.parse((row.paper_ids as string) || '[]'),
      createdAt: row.created_at as number,
    }));
  }

  deleteCollection(id: string): void {
    this.db.prepare('DELETE FROM collections WHERE id = ?').run(id);
  }

  // ─── Notes ──────────────────────────────────────────────────

  saveNote(note: {
    id: string; title: string; content: string; tags: string[];
    linkedPaperIds: string[]; linkedNoteIds: string[]; updatedAt: number;
    scope?: 'global' | 'research'; projectId?: string;
  }): void {
    const existing = this.db.prepare('SELECT project_id, scope FROM notes WHERE id = ?').get(note.id) as {
      project_id: string | null;
      scope: 'global' | 'research';
    } | undefined;
    const requestedScope = note.scope ?? existing?.scope ?? (note.projectId ? 'research' : 'global');
    const projectId = requestedScope === 'research' ? (note.projectId ?? existing?.project_id ?? undefined) : undefined;
    if (requestedScope === 'research' && !projectId) {
      throw new Error('Project-scoped research notes require a project id');
    }
    this.db.prepare(
      `INSERT INTO notes
       (id, project_id, scope, title, content, tags, linked_paper_ids, linked_note_ids, updated_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         project_id = excluded.project_id, scope = excluded.scope, title = excluded.title,
         content = excluded.content, tags = excluded.tags,
         linked_paper_ids = excluded.linked_paper_ids, linked_note_ids = excluded.linked_note_ids,
         updated_at = excluded.updated_at`,
    ).run(
      note.id, projectId ?? null, requestedScope, note.title, note.content, JSON.stringify(note.tags),
      JSON.stringify(note.linkedPaperIds), JSON.stringify(note.linkedNoteIds), note.updatedAt,
    );
  }

  getNotes(): Array<{
    id: string; title: string; content: string; tags: string[];
    linkedPaperIds: string[]; linkedNoteIds: string[]; updatedAt: number;
    scope: 'global' | 'research'; projectId?: string;
  }> {
    const rows = this.db.prepare('SELECT * FROM notes ORDER BY updated_at DESC').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      projectId: row.project_id === null || row.project_id === undefined ? undefined : String(row.project_id),
      scope: row.scope === 'research' ? 'research' : 'global',
      title: row.title as string,
      content: row.content as string,
      tags: JSON.parse((row.tags as string) || '[]'),
      linkedPaperIds: JSON.parse((row.linked_paper_ids as string) || '[]'),
      linkedNoteIds: JSON.parse((row.linked_note_ids as string) || '[]'),
      updatedAt: row.updated_at as number,
    }));
  }

  deleteNote(id: string): void {
    this.db.prepare('DELETE FROM notes WHERE id = ?').run(id);
  }

  // ─── Experiments ────────────────────────────────────────────

  saveExperiment(exp: {
    id: string; name: string; description: string; status: string;
    parameters: Record<string, string>; metrics: Record<string, number>;
    tags: string[]; notes: string; linkedPaperIds: string[];
    scriptPath?: string; scriptType?: string; createdAt: number;
  }): void {
    this.db.prepare(
      `INSERT OR REPLACE INTO experiments
       (id, name, description, status, parameters, metrics, tags, notes, linked_paper_ids, script_path, script_type, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      exp.id, exp.name, exp.description, exp.status,
      JSON.stringify(exp.parameters), JSON.stringify(exp.metrics),
      JSON.stringify(exp.tags), exp.notes, JSON.stringify(exp.linkedPaperIds),
      exp.scriptPath ?? null, exp.scriptType ?? null, exp.createdAt,
    );
  }

  getExperiments(): Array<{
    id: string; name: string; description: string; status: string;
    parameters: Record<string, string>; metrics: Record<string, number>;
    tags: string[]; notes: string; linkedPaperIds: string[];
    scriptPath?: string; scriptType?: string; createdAt: number;
  }> {
    const rows = this.db.prepare('SELECT * FROM experiments ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      status: row.status as string,
      parameters: JSON.parse((row.parameters as string) || '{}'),
      metrics: JSON.parse((row.metrics as string) || '{}'),
      tags: JSON.parse((row.tags as string) || '[]'),
      notes: row.notes as string,
      linkedPaperIds: JSON.parse((row.linked_paper_ids as string) || '[]'),
      scriptPath: (row.script_path as string | null) ?? undefined,
      scriptType: (row.script_type as string | null) ?? undefined,
      createdAt: row.created_at as number,
    }));
  }

  deleteExperiment(id: string): void {
    this.db.prepare('DELETE FROM experiments WHERE id = ?').run(id);
  }

  /** Renderer-safe experiment metadata only. Never selects legacy script columns. */
  getExperimentMetadata(): ExperimentMetadata[] {
    const rows = this.db.prepare(
      `SELECT id, name, description, status, parameters, metrics, tags, notes,
              linked_paper_ids, starred, created_at
       FROM experiments
       ORDER BY created_at DESC`,
    ).all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      description: row.description as string,
      status: row.status as ExperimentMetadata['status'],
      parameters: JSON.parse((row.parameters as string) || '{}') as Record<string, string>,
      metrics: JSON.parse((row.metrics as string) || '{}') as Record<string, number>,
      tags: JSON.parse((row.tags as string) || '[]') as string[],
      notes: row.notes as string,
      linkedPaperIds: JSON.parse((row.linked_paper_ids as string) || '[]') as string[],
      ...(row.starred === 1 ? { starred: true } : {}),
      createdAt: row.created_at as number,
    }));
  }

  saveExperimentMetadata(experiment: ExperimentMetadata): void {
    this.db.prepare(
      `INSERT INTO experiments
         (id, name, description, status, parameters, metrics, tags, notes,
          linked_paper_ids, starred, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       ON CONFLICT(id) DO UPDATE SET
         name = excluded.name,
         description = excluded.description,
         status = excluded.status,
         parameters = excluded.parameters,
         metrics = excluded.metrics,
         tags = excluded.tags,
         notes = excluded.notes,
         linked_paper_ids = excluded.linked_paper_ids,
         starred = excluded.starred`,
    ).run(
      experiment.id,
      experiment.name,
      experiment.description,
      experiment.status,
      JSON.stringify(experiment.parameters),
      JSON.stringify(experiment.metrics),
      JSON.stringify(experiment.tags),
      experiment.notes,
      JSON.stringify(experiment.linkedPaperIds),
      experiment.starred === true ? 1 : 0,
      experiment.createdAt,
    );
  }

  deleteExperimentMetadata(id: string): void {
    this.db.prepare('DELETE FROM experiments WHERE id = ?').run(id);
  }

  updateExperimentRunState(
    id: string,
    status: ExperimentMetadata['status'],
    metrics: Record<string, number>,
  ): boolean {
    const current = this.db.prepare(
      'SELECT metrics FROM experiments WHERE id = ?',
    ).get(id) as { metrics: string } | undefined;
    if (!current) return false;
    const existing = JSON.parse(current.metrics || '{}') as Record<string, number>;
    const result = this.db.prepare(
      'UPDATE experiments SET status = ?, metrics = ? WHERE id = ?',
    ).run(status, JSON.stringify({ ...existing, ...metrics }), id);
    return result.changes === 1;
  }

  /**
   * Run the script associated with an experiment.
   *
   * Supported script types: python (.py), node (.js/.mjs/.cjs), shell (.sh on Unix).
   * The stdout/stderr are captured. Lines matching `METRIC:<key>=<value>` are
   * parsed into experiment metrics. The status is updated to completed or failed.
   */
  async runExperimentScript(id: string): Promise<{
    success: boolean;
    stdout: string;
    stderr: string;
    exitCode: number | null;
    parsedMetrics: Record<string, number>;
  }> {
    const row = this.db.prepare('SELECT * FROM experiments WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) {
      throw new Error(`Experiment ${id} not found`);
    }

    const scriptPath = (row.script_path as string | null) ?? undefined;
    let scriptType = (row.script_type as string | null) ?? undefined;

    if (!scriptPath) {
      throw new Error(`Experiment ${id} has no associated script`);
    }

    if (!scriptType) {
      const ext = scriptPath.split('.').pop()?.toLowerCase();
      scriptType = ext === 'py' ? 'python' : ext === 'js' || ext === 'mjs' || ext === 'cjs' ? 'node' : 'sh';
    }

    const command = scriptType === 'python'
      ? (process.platform === 'win32' ? 'python' : 'python3')
      : scriptType === 'node'
        ? 'node'
        : scriptType === 'sh'
          ? (process.platform === 'win32' ? 'bash' : 'sh')
          : scriptType;

    const args = scriptType === 'sh' && process.platform !== 'win32' ? [scriptPath] : [scriptPath];

    const { spawn } = await import('node:child_process');
    return new Promise((resolve, reject) => {
      const proc = spawn(command, args, { cwd: process.cwd(), shell: process.platform === 'win32' });
      let stdout = '';
      let stderr = '';

      proc.stdout?.on('data', (data) => {
        stdout += data.toString();
      });
      proc.stderr?.on('data', (data) => {
        stderr += data.toString();
      });

      proc.on('error', (err) => reject(err));
      proc.on('close', (exitCode) => {
        const parsedMetrics: Record<string, number> = {};
        const metricRegex = /METRIC:([a-zA-Z0-9_-]+)=([0-9]+\.?[0-9]*)/g;
        let match;
        while ((match = metricRegex.exec(stdout)) !== null) {
          const key = match[1]!;
          const value = match[2]!;
          parsedMetrics[key] = Number.parseFloat(value);
        }

        const success = exitCode === 0;
        const status = success ? 'completed' : 'failed';
        const currentMetrics = JSON.parse((row.metrics as string) || '{}') as Record<string, number>;
        const currentNotes = (row.notes as string) || '';
        const timestamp = new Date().toISOString();
        const runNotes = `\n\n[Run ${timestamp}]\nExit code: ${exitCode ?? 'N/A'}\nStdout:\n${stdout.slice(0, 2000)}${stderr ? `\nStderr:\n${stderr.slice(0, 1000)}` : ''}`;

        this.db.prepare(
          `UPDATE experiments SET status = ?, metrics = ?, notes = ? WHERE id = ?`,
        ).run(
          status,
          JSON.stringify({ ...currentMetrics, ...parsedMetrics }),
          currentNotes + runNotes,
          id,
        );

        resolve({ success, stdout, stderr, exitCode, parsedMetrics });
      });
    });
  }

  // ─── Memory ─────────────────────────────────────────────────

  setMemory(key: string, value: string, category = 'general'): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT OR REPLACE INTO memory (key, value, category, project_id, created_at, updated_at) VALUES (?, ?, ?, NULL, ?, ?)',
    ).run(key, value, category, now, now);
  }

  /**
   * METIS-F12: project-scoped memories use a namespaced key (`p:{projectId}:{key}`)
   * so identical keys in different projects never collide, plus the project_id
   * column for filtered queries.
   */
  setMemoryScoped(projectId: string, key: string, value: string, category = 'general'): void {
    const now = Date.now();
    this.db.prepare(
      'INSERT OR REPLACE INTO memory (key, value, category, project_id, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)',
    ).run(`p:${projectId}:${key}`, value, category, projectId, now, now);
  }

  getMemory(key: string): { key: string; value: string; category: string; createdAt: number; updatedAt: number } | undefined {
    const row = this.db.prepare('SELECT * FROM memory WHERE key = ?').get(key) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return {
      key: row.key as string,
      value: row.value as string,
      category: row.category as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    };
  }

  getMemoryScoped(projectId: string, key: string): { key: string; value: string; category: string; createdAt: number; updatedAt: number } | undefined {
    return this.getMemory(`p:${projectId}:${key}`);
  }

  getMemoryByCategory(
    category: string,
    projectId?: string,
  ): Array<{ key: string; value: string; category: string; createdAt: number; updatedAt: number }> {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT * FROM memory WHERE category = ? AND project_id IS NULL ORDER BY updated_at DESC').all(category)
      : this.db.prepare('SELECT * FROM memory WHERE category = ? AND project_id = ? ORDER BY updated_at DESC').all(category, projectId);
    return (rows as Record<string, unknown>[]).map((row) => ({
      key: row.key as string,
      value: row.value as string,
      category: row.category as string,
      createdAt: row.created_at as number,
      updatedAt: row.updated_at as number,
    }));
  }

  listMemoryKeys(projectId?: string): string[] {
    const rows = projectId === undefined
      ? this.db.prepare('SELECT key FROM memory WHERE project_id IS NULL ORDER BY updated_at DESC').all()
      : this.db.prepare('SELECT key FROM memory WHERE project_id = ? ORDER BY updated_at DESC').all(projectId);
    return (rows as Record<string, unknown>[]).map((row) => row.key as string);
  }

  deleteMemory(key: string): void {
    this.db.prepare('DELETE FROM memory WHERE key = ?').run(key);
  }

  deleteMemoryScoped(projectId: string, key: string): void {
    this.db.prepare('DELETE FROM memory WHERE key = ?').run(`p:${projectId}:${key}`);
  }

  // ─── MCP Servers ────────────────────────────────────────────

  getMCPServers(): Array<{ id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean; createdAt: number }> {
    const rows = this.db.prepare('SELECT * FROM mcp_servers ORDER BY created_at DESC').all() as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      name: row.name as string,
      command: row.command as string,
      args: JSON.parse(row.args as string) as string[],
      env: JSON.parse(row.env as string) as Record<string, string>,
      enabled: (row.enabled as number) === 1,
      createdAt: row.created_at as number,
    }));
  }

  saveMCPServer(server: { id: string; name: string; command: string; args: string[]; env: Record<string, string>; enabled: boolean; createdAt: number }): void {
    this.db.prepare(
      'INSERT OR REPLACE INTO mcp_servers (id, name, command, args, env, enabled, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run(
      server.id,
      server.name,
      server.command,
      JSON.stringify(server.args),
      JSON.stringify(server.env),
      server.enabled ? 1 : 0,
      server.createdAt,
    );
  }

  deleteMCPServer(id: string): void {
    this.db.prepare('DELETE FROM mcp_servers WHERE id = ?').run(id);
  }

  toggleMCPServer(id: string, enabled: boolean): void {
    this.db.prepare('UPDATE mcp_servers SET enabled = ? WHERE id = ?').run(enabled ? 1 : 0, id);
  }

  // ─── Bulk Load ──────────────────────────────────────────────

  getAllData(): {
    papers: ReturnType<PersistenceStore['getPapers']>;
    notes: ReturnType<PersistenceStore['getNotes']>;
    experiments: ReturnType<PersistenceStore['getExperiments']>;
    collections: ReturnType<PersistenceStore['getCollections']>;
  } {
    return {
      papers: this.getPapers(),
      notes: this.getNotes(),
      experiments: this.getExperiments(),
      collections: this.getCollections(),
    };
  }

  /** Single paper with full fields (including pdfText) by id. */
  getPaper(id: string): ReturnType<PersistenceStore['getPapers']>[number] | undefined {
    const row = this.db.prepare('SELECT * FROM papers WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    return this.getPapers().find((p) => p.id === id);
  }

  // ─── Artifacts ──────────────────────────────────────────────

  createArtifact(record: ArtifactCreateRecord): void {
    this.createArtifacts([record]);
  }

  /**
   * Atomically persists generated artifacts. A deterministic id may be replayed
   * only when every persisted field is identical; conflicting content is never
   * silently overwritten.
   *
   * Every artifact created inside a project-scoped session is mirrored (same
   * transaction) into the project-owned research_artifacts/artifact_versions store,
   * so conversation deletion can never destroy a project asset. Artifacts of
   * project-less sessions are mirrored when their session is deleted (they land in
   * the system unassigned project).
   */
  createArtifacts(records: ArtifactCreateRecord[]): void {
    const select = this.db.prepare(
      'SELECT session_id, name, type, path, size, content, metadata FROM artifacts WHERE id = ?',
    );
    const insert = this.db.prepare(
      'INSERT INTO artifacts (id, session_id, name, type, path, size, content, metadata, created_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const sessionProject = this.db.prepare('SELECT project_id FROM sessions WHERE id = ?');
    const persist = this.db.transaction((batch: ArtifactCreateRecord[]) => {
      const createdAt = Date.now();
      for (const record of batch) {
        if (record.content !== undefined && !ArtifactContentSchema.safeParse(record.content).success) {
          throw new Error('Artifact content is invalid');
        }
        const pathValue = record.path ?? null;
        const sizeValue = record.size ?? null;
        const contentValue = record.content ?? null;
        const metadataValue = JSON.stringify(record.metadata ?? {});
        const existing = select.get(record.id) as {
          session_id: string;
          name: string;
          type: string;
          path: string | null;
          size: string | null;
          content: string | null;
          metadata: string;
        } | undefined;
        if (existing) {
          const identical = existing.session_id === record.sessionId
            && existing.name === record.name
            && existing.type === record.type
            && existing.path === pathValue
            && existing.size === sizeValue
            && existing.content === contentValue
            && existing.metadata === metadataValue;
          if (!identical) throw new Error('Artifact id conflicts with a different record');
          continue;
        }
        insert.run(
          record.id,
          record.sessionId,
          record.name,
          record.type,
          pathValue,
          sizeValue,
          contentValue,
          metadataValue,
          createdAt,
        );
        // Project-owned mirror (task 1 §五): session-scoped rows stay for the
        // conversation UI; the project asset must survive conversation deletion.
        const session = sessionProject.get(record.sessionId) as { project_id: string | null } | undefined;
        const projectId = session?.project_id;
        if (projectId) {
          this.mirrorLegacyArtifactToProject({
            id: record.id,
            session_id: record.sessionId,
            name: record.name,
            type: record.type,
            path: pathValue,
            size: sizeValue,
            content: contentValue,
            metadata: metadataValue,
            created_at: createdAt,
          }, projectId);
        }
      }
    });
    persist(records);
  }

  /**
   * Make sure the artifact-owning project exists (the system unassigned project is
   * created lazily on first use; real projects always exist before their sessions).
   */
  private ensureArtifactOwnerProject(projectId: string): void {
    if (projectId !== UNASSIGNED_ARTIFACT_PROJECT_ID) return;
    this.db.prepare(`
      INSERT OR IGNORE INTO projects (id, title, original_intent, lifecycle, metadata, created_at, updated_at, version, source)
      VALUES (?, ?, '', 'archived', '{}', ?, ?, 1, 'system')
    `).run(
      UNASSIGNED_ARTIFACT_PROJECT_ID,
      '系统收容成果（未归属会话）',
      Date.now(),
      Date.now(),
    );
  }

  /**
   * Idempotently mirror a legacy session-owned artifact row into the project-owned
   * store. The mirror carries the original session id as provenance; the owner is
   * always the project (never switched back to a session).
   */
  private mirrorLegacyArtifactToProject(artifact: LegacyArtifactRow, projectId: string, options?: { migrated?: boolean }): void {
    this.ensureArtifactOwnerProject(projectId);
    const now = Date.now();
    const mirrorId = projectArtifactMirrorId(artifact.id);
    const provenance = JSON.stringify({
      createdBySessionId: artifact.session_id,
      sourceArtifactId: artifact.id,
      ...(options?.migrated ? { migratedFrom: 'legacy_artifacts', migratedAt: now } : {}),
    });
    const inserted = this.db.prepare(`
      INSERT INTO research_artifacts (id, project_id, title, artifact_type, review_status, content_ref, provenance, metadata, version, created_at, updated_at)
      VALUES (?, ?, ?, ?, 'draft', ?, ?, ?, 1, ?, ?)
      ON CONFLICT(id) DO NOTHING
    `).run(
      mirrorId,
      projectId,
      artifact.name,
      artifact.type || 'other',
      artifact.path,
      provenance,
      artifact.metadata || '{}',
      artifact.created_at,
      now,
    );
    if (Number(inserted.changes) === 0) return; // already mirrored (dual-write or earlier migration)
    const content = artifact.content ?? '';
    this.db.prepare(`
      INSERT INTO artifact_versions (artifact_id, version, manifest, content, content_hash, created_at, created_by)
      VALUES (?, 1, ?, ?, ?, ?, 'session')
    `).run(
      mirrorId,
      JSON.stringify({
        name: artifact.name,
        type: artifact.type,
        path: artifact.path,
        size: artifact.size,
        sessionId: artifact.session_id,
        sourceArtifactId: artifact.id,
      }),
      content,
      createHash('sha256').update(content, 'utf8').digest('hex'),
      artifact.created_at,
    );
  }

  listArtifacts(sessionId: string): Array<{
    id: string;
    sessionId: string;
    name: string;
    type: string;
    path?: string;
    size?: string;
    metadata: Record<string, unknown>;
    contentAvailable: boolean;
    createdAt: number;
  }> {
    const rows = this.db
      .prepare(`SELECT id, session_id, name, type, path, size, metadata, created_at,
        content IS NOT NULL AS content_available
        FROM artifacts WHERE session_id = ? ORDER BY created_at DESC`)
      .all(sessionId) as Record<string, unknown>[];
    return rows.map((row) => ({
      id: row.id as string,
      sessionId: row.session_id as string,
      name: row.name as string,
      type: row.type as string,
      path: (row.path as string | null) ?? undefined,
      size: (row.size as string | null) ?? undefined,
      metadata: JSON.parse((row.metadata as string) || '{}'),
      contentAvailable: row.content_available === 1,
      createdAt: row.created_at as number,
    }));
  }

  getArtifactContent(artifactId: string, sessionId: string): ArtifactContentRecord | undefined {
    const row = this.db.prepare(
      `SELECT id, session_id, name, type, content, created_at
       FROM artifacts WHERE id = ? AND session_id = ? AND content IS NOT NULL`,
    ).get(artifactId, sessionId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    const content = ArtifactContentSchema.safeParse(row.content);
    if (!content.success) return undefined;
    return {
      id: row.id as string,
      sessionId: row.session_id as string,
      name: row.name as string,
      type: row.type as string,
      content: content.data,
      createdAt: row.created_at as number,
    };
  }

  /**
   * Explicit user deletion of one artifact removes both the session-scoped row and
   * its project-owned mirror (soft delete, keeping version history rows).
   */
  deleteArtifact(id: string): void {
    const now = Date.now();
    this.db.transaction(() => {
      this.db.prepare('DELETE FROM artifacts WHERE id = ?').run(id);
      this.db.prepare('UPDATE research_artifacts SET deleted_at = ?, updated_at = ? WHERE id = ? AND deleted_at IS NULL')
        .run(now, now, projectArtifactMirrorId(id));
    })();
  }

  // ─── Agent execution runs and event ledger ───────────────────

  beginAgentRun(input: {
    runId: string;
    sessionId: string;
    turnId: string;
    projectId?: string;
    startedAt?: number;
    metadata?: Record<string, unknown>;
  }): boolean {
    const result = this.db.prepare(
      `INSERT OR IGNORE INTO agent_runs
       (run_id, session_id, turn_id, project_id, status, started_at, last_sequence, metadata)
       VALUES (?, ?, ?, ?, 'running', ?, -1, ?)`,
    ).run(
      input.runId,
      input.sessionId,
      input.turnId,
      input.projectId ?? null,
      input.startedAt ?? Date.now(),
      JSON.stringify(input.metadata ?? {}),
    );
    return Number(result.changes) > 0;
  }

  finishAgentRun(input: {
    runId: string;
    sessionId?: string;
    status: string;
    completedAt?: number;
    terminalReason?: string;
  }): boolean {
    const result = this.db.prepare(
      `UPDATE agent_runs SET status = ?, completed_at = ?, terminal_reason = ?
       WHERE run_id = ?${input.sessionId === undefined ? '' : ' AND session_id = ?'}`,
    ).run(
      input.status,
      input.completedAt ?? Date.now(),
      input.terminalReason ?? null,
      input.runId,
      ...(input.sessionId === undefined ? [] : [input.sessionId]),
    );
    return Number(result.changes) > 0;
  }

  /**
   * Startup crash reconciliation (Engineering Delivery Ready P0-8): any run
   * still marked 'running' when the store opens belongs to a process that no
   * longer exists — the single-instance lock guarantees no other writer.
   * Deterministically retire them as interrupted instead of leaving zombie
   * "running" rows that the UI would render as endless spinners. Returns the
   * number of reconciled rows so startup health can report it.
   */
  reconcileOrphanRunningRuns(recoveredAt: number): number {
    const result = this.db.prepare(
      `UPDATE agent_runs
       SET status = 'interrupted', terminal_reason = 'process_crash', completed_at = ?
       WHERE status = 'running'`,
    ).run(recoveredAt);
    return Number(result.changes);
  }

  /** 任务2 Context Provenance：记录一次重要 run 装入了哪些 scope 的上下文（幂等覆盖写）。 */
  recordContextProvenance(input: {
    runId: string;
    sessionId: string;
    projectId?: string;
    provenance: object;
  }): void {
    this.db.prepare(
      `INSERT INTO context_provenance (run_id, session_id, project_id, provenance_json, created_at)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(run_id) DO UPDATE SET provenance_json = excluded.provenance_json, project_id = excluded.project_id`,
    ).run(
      input.runId,
      input.sessionId,
      input.projectId ?? null,
      JSON.stringify(input.provenance),
      Date.now(),
    );
  }

  getContextProvenance(runId: string): { runId: string; sessionId: string; projectId?: string; provenance: Record<string, unknown>; createdAt: number } | undefined {
    const row = this.db.prepare('SELECT * FROM context_provenance WHERE run_id = ?').get(runId) as Record<string, unknown> | undefined;
    if (!row) return undefined;
    let provenance: Record<string, unknown> = {};
    try { const parsed = JSON.parse((row.provenance_json as string) || '{}'); if (parsed && typeof parsed === 'object') provenance = parsed; } catch { provenance = {}; }
    return {
      runId: row.run_id as string,
      sessionId: row.session_id as string,
      ...(typeof row.project_id === 'string' ? { projectId: row.project_id } : {}),
      provenance,
      createdAt: row.created_at as number,
    };
  }

  getAgentRun(runId: string, sessionId?: string): AgentRunRecord | undefined {
    const row = this.db.prepare(
      `SELECT * FROM agent_runs WHERE run_id = ?${sessionId === undefined ? '' : ' AND session_id = ?'}`,
    ).get(...(sessionId === undefined ? [runId] : [runId, sessionId])) as Record<string, unknown> | undefined;
    if (!row) return undefined;    let metadata: Record<string, unknown> = {};
    try {
      const parsed = JSON.parse((row.metadata as string) || '{}');
      if (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) metadata = parsed as Record<string, unknown>;
    } catch { /* malformed metadata is ignored at the boundary */ }
    return {
      runId: row.run_id as string,
      sessionId: row.session_id as string,
      turnId: row.turn_id as string,
      projectId: (row.project_id as string | null) ?? undefined,
      status: row.status as string,
      startedAt: row.started_at as number,
      completedAt: (row.completed_at as number | null) ?? undefined,
      lastSequence: row.last_sequence as number,
      eventsPruned: row.events_pruned === 1,
      terminalReason: (row.terminal_reason as string | null) ?? undefined,
      metadata,
    };
  }

  listAgentRuns(sessionId: string): AgentRunRecord[] {
    const rows = this.db.prepare('SELECT run_id FROM agent_runs WHERE session_id = ? ORDER BY started_at ASC').all(sessionId) as Array<{ run_id: string }>;
    return rows.flatMap((row) => {
      const run = this.getAgentRun(row.run_id, sessionId);
      return run ? [run] : [];
    });
  }

  /** Append one validated event; duplicate event IDs are acknowledged without a second row. */
  appendAgentEvent(event: AgentExecutionEvent, maxEvents: number = CHAT_RUNTIME_LIMITS.agentLedgerEventsPerRun): boolean {
    const parsed = AgentExecutionEventSchema.safeParse(event);
    if (!parsed.success) return false;
    const value = parsed.data;
    this.db.prepare(
      `INSERT OR IGNORE INTO agent_runs
       (run_id, session_id, turn_id, status, started_at, last_sequence, metadata)
       VALUES (?, ?, ?, 'running', ?, -1, '{}')`,
    ).run(value.runId, value.sessionId, value.turnId, Date.now());
    const inserted = this.db.prepare(
      `INSERT OR IGNORE INTO agent_events
       (event_id, run_id, session_id, turn_id, sequence, correlation_id, version, event_json, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    ).run(
      value.eventId, value.runId, value.sessionId, value.turnId, value.sequence,
      value.correlationId, value.version, JSON.stringify(value), Date.now(),
    );
    const pruned = this.db.prepare(
      `DELETE FROM agent_events WHERE run_id = ? AND sequence <= (
         SELECT COALESCE(MAX(sequence), 0) - ? FROM agent_events WHERE run_id = ?
       )`,
    ).run(value.runId, Math.max(1, Math.floor(maxEvents)), value.runId);
    const lastSequence = this.db.prepare(
      'SELECT MAX(sequence) AS sequence FROM agent_events WHERE run_id = ?',
    ).get(value.runId) as { sequence?: number | null } | undefined;
    this.db.prepare(
      `UPDATE agent_runs SET last_sequence = ?, events_pruned = CASE WHEN events_pruned = 1 OR ? > 0 THEN 1 ELSE 0 END
       WHERE run_id = ? AND session_id = ?`,
    ).run(lastSequence?.sequence ?? value.sequence, Number(pruned.changes), value.runId, value.sessionId);
    return Number(inserted.changes) > 0;
  }

  getAgentEventsAfter(
    sessionId: string,
    runId: string,
    afterSequence = -1,
    limit: number = CHAT_RUNTIME_LIMITS.agentReplayEvents,
  ): AgentExecutionEvent[] {
    const rows = this.db.prepare(
      `SELECT event_json FROM agent_events
       WHERE session_id = ? AND run_id = ? AND sequence > ?
       ORDER BY sequence ASC LIMIT ?`,
    ).all(sessionId, runId, Math.max(-1, Math.floor(afterSequence)), Math.min(
      CHAT_RUNTIME_LIMITS.agentReplayEvents, Math.max(1, Math.floor(limit)),
    )) as Array<{ event_json: string }>;
    const events: AgentExecutionEvent[] = [];
    for (const row of rows) {
      try {
        const parsed = AgentExecutionEventSchema.safeParse(JSON.parse(row.event_json));
        if (parsed.success) events.push(parsed.data);
      } catch { /* malformed persisted rows are skipped at the boundary */ }
    }
    return events;
  }

  // ─── Lifecycle ──────────────────────────────────────────────

  /**
   * Online backup to a destination file using better-sqlite3's backup API.
   * Safe to call while the app is running (readers/writers are not blocked).
   * Returns the backup metadata (total pages, etc.) on completion.
   */
  async backupTo(destinationPath: string): Promise<{ destination: string; totalPages: number }> {
    const meta = await this.db.backup(destinationPath);
    return { destination: destinationPath, totalPages: meta.totalPages };
  }

  /**
   * Flush the WAL back into the main database file (used before a backup-file swap,
   * so the on-disk file is self-contained without its -wal sidecar).
   */
  checkpointWal(): void {
    this.db.pragma('wal_checkpoint(TRUNCATE)');
  }

  close(): void {
    this.db.close();
  }
}

/** Global shared store instance, set by the Electron main process on startup. */
export let sharedStore: PersistenceStore | null = null;

export function setSharedStore(store: PersistenceStore): void {
  sharedStore = store;
}
