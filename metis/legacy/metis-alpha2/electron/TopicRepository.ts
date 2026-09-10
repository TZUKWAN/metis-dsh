import type { Database } from 'better-sqlite3';
import {
  TopicCandidateDtoSchema,
  TopicConstraintsSchema,
  TopicMessageDtoSchema,
  TopicSessionDtoSchema,
  type TopicCandidateDto,
  type TopicMessageDto,
  type TopicSessionDto,
} from '../engine/runtime/TopicRuntimeContract.js';

/**
 * Topic(选题)持久化(2026-09-04 刘总要求:选题一级功能)。
 * 仿 OutcomeRepository 的极简模式:db.prepare 一行式,JSON 列手动 encode/decode,
 * 解析失败的行静默跳过(不让单行脏数据打挂整个列表)。
 */

export class TopicRepository {
  constructor(private readonly db: Database) {}

  /**
   * 任务1（§七）：跨 repository 的用户动作（候选 → 项目转换）需要统一事务边界。
   * 在外层事务内调用其它 repository 时，better-sqlite3 会把它们的内层事务降级为
   * SAVEPOINT，整体保持原子。
   */
  runInTransaction<T>(fn: () => T): T {
    return this.db.transaction(fn)();
  }

  // ── sessions ──

  createSession(session: TopicSessionDto): void {
    this.db.prepare(
      'INSERT INTO topic_sessions (id, title, initial_intent, source_project_id, discipline, constraints_json, status, selected_candidate_id, research_brief, category, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      session.id, session.title, session.initialIntent, session.sourceProjectId, session.discipline,
      session.constraints ? JSON.stringify(session.constraints) : null, session.status,
      session.selectedCandidateId, session.researchBrief, session.category, session.createdAt, session.updatedAt,
    );
  }

  getSession(id: string): TopicSessionDto | null {
    const row = this.db.prepare('SELECT * FROM topic_sessions WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    if (!row) return null;
    return this.decodeSession(row);
  }

  listSessions(): TopicSessionDto[] {
    const rows = this.db.prepare('SELECT * FROM topic_sessions ORDER BY updated_at DESC').all() as Array<Record<string, unknown>>;
    return rows.map((row) => this.decodeSession(row)).filter((item): item is TopicSessionDto => item !== null);
  }

  updateSession(id: string, patch: Partial<TopicSessionDto>): TopicSessionDto | null {
    const current = this.getSession(id);
    if (!current) return null;
    const next: TopicSessionDto = { ...current, ...patch, updatedAt: Date.now() };
    this.db.prepare(
      'UPDATE topic_sessions SET title = ?, initial_intent = ?, source_project_id = ?, discipline = ?, constraints_json = ?, status = ?, selected_candidate_id = ?, research_brief = ?, category = ?, updated_at = ? WHERE id = ?',
    ).run(
      next.title, next.initialIntent, next.sourceProjectId, next.discipline,
      next.constraints ? JSON.stringify(next.constraints) : null, next.status,
      next.selectedCandidateId, next.researchBrief, next.category, next.updatedAt, id,
    );
    return this.getSession(id);
  }

  private decodeSession(row: Record<string, unknown>): TopicSessionDto | null {
    let constraints: TopicSessionDto['constraints'] = null;
    if (typeof row.constraints_json === 'string' && row.constraints_json) {
      try {
        const parsed = TopicConstraintsSchema.safeParse(JSON.parse(row.constraints_json));
        constraints = parsed.success ? parsed.data : null;
      } catch { constraints = null; }
    }
    const checked = TopicSessionDtoSchema.safeParse({
      id: row.id,
      title: row.title,
      initialIntent: row.initial_intent ?? '',
      sourceProjectId: row.source_project_id ?? null,
      discipline: row.discipline ?? '',
      constraints,
      status: row.status,
      selectedCandidateId: row.selected_candidate_id ?? null,
      researchBrief: row.research_brief ?? null,
      // 旧库行经迁移 117 补列后为 NULL=未分类;更旧的脏库防御性兜底。
      category: row.category ?? null,
      createdAt: row.created_at,
      updatedAt: row.updated_at,
    });
    return checked.success ? checked.data : null;
  }

  // ── candidates ──

  upsertCandidate(candidate: TopicCandidateDto): void {
    const exists = this.db.prepare('SELECT id FROM topic_candidates WHERE id = ?').get(candidate.id);
    if (exists) {
      this.db.prepare(
        'UPDATE topic_candidates SET title = ?, research_question = ?, summary = ?, rationale = ?, existing_research = ?, research_gap = ?, theoretical_angles_json = ?, method_options_json = ?, data_options_json = ?, novelty_analysis = ?, feasibility_analysis = ?, risks_json = ?, closest_studies_json = ?, evidence_refs_json = ?, status = ?, project_id = ?, scenario_id = ?, converted_at = ?, updated_at = ? WHERE id = ?',
      ).run(
        candidate.title, candidate.researchQuestion, candidate.summary, candidate.rationale, candidate.existingResearch,
        candidate.researchGap, JSON.stringify(candidate.theoreticalAngles), JSON.stringify(candidate.methodOptions),
        JSON.stringify(candidate.dataOptions), candidate.noveltyAnalysis, candidate.feasibilityAnalysis,
        JSON.stringify(candidate.risks), JSON.stringify(candidate.closestStudies), JSON.stringify(candidate.evidenceRefs),
        candidate.status, candidate.projectId, candidate.scenarioId, candidate.convertedAt, candidate.updatedAt, candidate.id,
      );
      return;
    }
    this.db.prepare(
      'INSERT INTO topic_candidates (id, session_id, title, research_question, summary, rationale, existing_research, research_gap, theoretical_angles_json, method_options_json, data_options_json, novelty_analysis, feasibility_analysis, risks_json, closest_studies_json, evidence_refs_json, status, project_id, scenario_id, converted_at, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    ).run(
      candidate.id, candidate.sessionId, candidate.title, candidate.researchQuestion, candidate.summary,
      candidate.rationale, candidate.existingResearch, candidate.researchGap,
      JSON.stringify(candidate.theoreticalAngles), JSON.stringify(candidate.methodOptions), JSON.stringify(candidate.dataOptions),
      candidate.noveltyAnalysis, candidate.feasibilityAnalysis, JSON.stringify(candidate.risks),
      JSON.stringify(candidate.closestStudies), JSON.stringify(candidate.evidenceRefs),
      candidate.status, candidate.projectId, candidate.scenarioId, candidate.convertedAt, candidate.createdAt, candidate.updatedAt,
    );
  }

  getCandidate(id: string): TopicCandidateDto | null {
    const row = this.db.prepare('SELECT * FROM topic_candidates WHERE id = ?').get(id) as Record<string, unknown> | undefined;
    return row ? decodeCandidateRow(row) : null;
  }

  listCandidates(sessionId: string): TopicCandidateDto[] {
    const rows = this.db.prepare('SELECT * FROM topic_candidates WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => decodeCandidateRow(row)).filter((item): item is TopicCandidateDto => item !== null);
  }

  // ── messages ──

  appendMessage(message: TopicMessageDto): void {
    this.db.prepare(
      'INSERT INTO topic_messages (id, session_id, role, content, created_at) VALUES (?, ?, ?, ?, ?)',
    ).run(message.id, message.sessionId, message.role, message.content, message.createdAt);
  }

  listMessages(sessionId: string): TopicMessageDto[] {
    const rows = this.db.prepare('SELECT * FROM topic_messages WHERE session_id = ? ORDER BY created_at ASC').all(sessionId) as Array<Record<string, unknown>>;
    return rows.map((row) => {
      const checked = TopicMessageDtoSchema.safeParse({
        id: row.id, sessionId: row.session_id, role: row.role, content: row.content, createdAt: row.created_at,
      });
      return checked.success ? checked.data : null;
    }).filter((item): item is TopicMessageDto => item !== null);
  }
}

function decodeCandidateRow(row: Record<string, unknown>): TopicCandidateDto | null {
  const array = <T,>(raw: unknown): T[] => {
    try {
      const parsed = JSON.parse((raw as string) || '[]') as T[];
      return Array.isArray(parsed) ? parsed : [];
    } catch { return []; }
  };
  const checked = TopicCandidateDtoSchema.safeParse({
    id: row.id,
    sessionId: row.session_id,
    title: row.title,
    researchQuestion: row.research_question ?? '',
    summary: row.summary ?? '',
    rationale: row.rationale ?? '',
    existingResearch: row.existing_research ?? '',
    researchGap: row.research_gap ?? '',
    theoreticalAngles: array<string>(row.theoretical_angles_json),
    methodOptions: array<string>(row.method_options_json),
    dataOptions: array<string>(row.data_options_json),
    noveltyAnalysis: row.novelty_analysis ?? '',
    feasibilityAnalysis: row.feasibility_analysis ?? '',
    risks: array<string>(row.risks_json),
    closestStudies: array<string>(row.closest_studies_json),
    evidenceRefs: array<TopicCandidateDto['evidenceRefs'][number]>(row.evidence_refs_json),
    status: row.status,
    projectId: row.project_id ?? null,
    scenarioId: row.scenario_id ?? null,
    convertedAt: row.converted_at ?? null,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  });
  return checked.success ? checked.data : null;
}
