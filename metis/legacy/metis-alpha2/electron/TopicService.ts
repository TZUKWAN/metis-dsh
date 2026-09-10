import { randomUUID } from 'node:crypto';
import {
  TopicResearchBriefSchema,
  TopicStructuredBlockSchema,
  type TopicStructuredBlock,
  type TopicCandidateDto,
  type TopicConstraints,
  type TopicMessageDto,
  type TopicResearchBrief,
  type TopicSessionDto,
} from '../engine/runtime/TopicRuntimeContract.js';
import type { TopicRepository } from './TopicRepository.js';
import type { ResearchRepository } from '../engine/persistence/ResearchRepository.js';
import type { Project } from '../engine/persistence/researchModel.js';

/**
 * Topic(选题)服务(2026-09-04 刘总要求:选题一级功能)。
 *
 * 职责:会话/候选/消息编排 + 复用现有 agent runtime 跑选题对话(runEphemeralChatTurn,
 * 真实检索工具白名单)+ 从模型回答中确定性解析结构化块入库 + 生成 Topic Research
 * Brief。禁止凭模型记忆假装综述;检索失败与 0 结果必须区分(提示词硬约束)。
 */

/** 选题 Agent 可用检索工具(全部为现有真实工具;中英文+本地库+网页)。 */
export const TOPIC_SEARCH_TOOLS = [
  'search_papers', 'arxiv_search', 'openalex_lookup', 'crossref_lookup', 'recommend_papers',
  'ncpssd_search', 'web_search', 'web_fetch', 'search_library', 'fulltext_search',
] as const;

export interface TopicChatTurnOptions {
  sessionId: string;
  messages: Array<{ role: 'user' | 'assistant'; content: string }>;
  skillPrompt?: string;
  allowedTools?: readonly string[];
  maxTurns?: number;
  signal?: AbortSignal;
  projectId?: string;
}

export interface TopicAgentResponse {
  status: string;
  answer: string;
  diagnostics?: Array<{ code?: string; message?: string }>;
}

export type TopicChatTurnRunner = (options: TopicChatTurnOptions) => Promise<TopicAgentResponse>;

export interface TopicServiceOptions {
  /** 持久化初始化晚于服务构造时,传 getter(main.ts 惰性解析)。 */
  repository: TopicRepository | null | (() => TopicRepository | null);
  /** 由 main.ts 注入(包装 runEphemeralChatTurn),避免本模块绑定具体 agentLoop 实例。 */
  runTurn: TopicChatTurnRunner;
  /** 任务1（§七）：候选→项目事务化转换需要研究库；main.ts 惰性注入。 */
  researchRepository?: () => ResearchRepository | null;
}

const MAX_CHAT_TURNS = 30;

function buildTopicSystemPrompt(session: TopicSessionDto): string {
  const constraints = session.constraints;
  const constraintLines: string[] = [];
  if (constraints) {
    if (constraints.researchTypes?.length) constraintLines.push(`研究类型:${constraints.researchTypes.join('、')}`);
    if (constraints.targetPublications?.length) constraintLines.push(`目标发表:${constraints.targetPublications.join('、')}`);
    if (constraints.methodPreference) constraintLines.push(`方法偏好:${constraints.methodPreference}`);
    if (constraints.dataConditions) constraintLines.push(`数据条件:${constraints.dataConditions}`);
    if (constraints.timeConstraints) constraintLines.push(`时间约束:${constraints.timeConstraints}`);
    if (constraints.exclusions) constraintLines.push(`明确不做:${constraints.exclusions}`);
    if (constraints.extra) constraintLines.push(`其他:${constraints.extra}`);
  }
  return [
    '你是 METIS 选题研究 Agent(2026-09-04)。你的工作:从用户的研究意图出发,通过真实检索形成研究版图,提出并论证候选选题,与用户交互收敛,最终确认一个可进入场景构建的选题。',
    '',
    'HARD RULES(违反任何一条即为失败):',
    '1. 先理解用户意图;缺什么问什么;信息足够立即开始检索,禁止机械问卷。',
    '2. 不凭模型记忆假装文献调查。所有"已有研究/研究空白/拥挤方向"判断必须来自本轮真实工具调用结果。',
    '3. 必须同时检索中文与英文:中文用 ncpssd_search(国家哲学社会科学文献中心)+ web_search;英文用 search_papers / arxiv_search / openalex_lookup / crossref_lookup;用户本地库用 search_library / fulltext_search。',
    '4. 严格区分「0 结果」和「来源不可用」。某来源失败时明确说"该来源本轮不可用",绝不能说"没有找到相关中文研究"。',
    '5. 禁止自动宣称"首次研究/填补空白/国内尚无研究"。默认表述:"在本轮检索范围内,暂未发现高度相同研究(不等于证明不存在)"。',
    '6. 候选之间必须真实有差异;不为凑数量制造标题。用户条件是硬约束。',
    '7. 候选评价使用定性判断(创新空间:较明确/有限/高度拥挤/需继续验证;可行性:较高/中等/存在明显风险)并给出理由。严禁编造"创新性 91 分"这类伪精确评分。',
    '8. 重要判断尽可能引用真实来源(标题/作者/年份/DOI或URL)。发现候选明显不可行时直接指出,不谄媚用户的原始想法。',
    '9. 不为本轮无法核验的信息编造题录;没有真实来源支撑的判断要明确说"这是基于通用领域知识的初步判断,尚未检索验证"。',
    '',
    constraintLines.length > 0 ? `用户已确认的约束:\n${constraintLines.map((line) => `- ${line}`).join('\n')}` : '',
    session.sourceProjectId ? `本选题基于已有科研项目(projectId: ${session.sourceProjectId})开展:先读取并分析项目已有材料、文献与成果,寻找第二篇/第三篇论文方向,避免与已有成果重复。` : '',
    '',
    'STRUCTURED OUTPUT PROTOCOL(机器解析,必须严格遵守):当你形成/更新候选、完成研究版图、或用户确认选题时,除自然语言说明外,必须在回答末尾输出一个 ```json fenced block,只能是以下类型之一:',
    '{"type":"candidates_update","candidates":[{"title":"...","researchQuestion":"...","summary":"...","rationale":"...","existingResearch":"...","researchGap":"...","theoreticalAngles":["..."],"methodOptions":["..."],"dataOptions":["..."],"noveltyAnalysis":"较明确|有限|高度拥挤|需继续验证 + 理由","feasibilityAnalysis":"较高|中等|存在明显风险 + 理由","risks":["..."],"closestStudies":["..."],"evidenceRefs":[{"title":"...","authors":["..."],"year":2024,"venue":"...","doi":"...","url":"...","claim":"该判断依据"}]}]}',
    '{"type":"research_landscape","landscape":"(完整研究版图 markdown:主要主题/理论路径/方法/对象/热点/拥挤方向/争议/研究空间/中英文研究特点)"}',
    '{"type":"selection","selectedTitle":"用户确认的候选标题"}',
    '{"type":"status_update","sessionStatus":"exploring|researching|comparing|selected"}',
    'candidates_update 中的候选按 title 与已有候选合并(同 title 更新,新 title 新增);候选 id 由系统管理,不要编造。',
    '证据字段 evidenceRefs 每个对象只允许来自本轮真实工具结果;title 必填,doi/url 至少一项。',
  ].filter(Boolean).join('\n');
}

/** 从模型回答中提取 ```json fenced 结构化块(仅接受 TOPIC_BLOCK_TYPES)。 */
export function extractTopicStructuredBlocks(answer: string): TopicStructuredBlockExtract[] {
  const results: TopicStructuredBlockExtract[] = [];
  const fencePattern = /```(?:json)?\s*([\s\S]*?)```/gu;
  for (const match of answer.matchAll(fencePattern)) {
    const raw = match[1]?.trim();
    if (!raw || !raw.startsWith('{')) continue;
    try {
      const parsed = JSON.parse(raw) as unknown;
      const checked = TopicStructuredBlockSchema.safeParse(parsed);
      if (checked.success) results.push({ block: checked.data, start: match.index ?? 0, end: (match.index ?? 0) + match[0].length });
    } catch { /* 非 JSON 围栏(如题录数组)忽略 */ }
  }
  return results;
}

export interface TopicStructuredBlockExtract {
  block: TopicStructuredBlock;
  start: number;
  end: number;
}

/** 去掉结构化 JSON 块后的用户可见回答。 */
export function stripTopicBlocks(answer: string): string {
  let output = answer;
  for (const extract of extractTopicStructuredBlocks(answer).sort((a, b) => b.start - a.start)) {
    output = output.slice(0, extract.start) + output.slice(extract.end);
  }
  return output.trim();
}

export class TopicService {
  constructor(private readonly options: TopicServiceOptions) {}

  private get repo(): TopicRepository {
    const resolved = typeof this.options.repository === 'function' ? this.options.repository() : this.options.repository;
    if (!resolved) throw new Error('topic_persistence_unavailable');
    return resolved;
  }

  createSession(input: { title?: string; initialIntent?: string; sourceProjectId?: string | null; discipline?: string; constraints?: TopicConstraints; category?: string | null }): TopicSessionDto {
    const now = Date.now();
    const session: TopicSessionDto = {
      id: `topic_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
      title: input.title?.trim() || '新选题',
      initialIntent: input.initialIntent?.trim() ?? '',
      sourceProjectId: input.sourceProjectId ?? null,
      discipline: input.discipline?.trim() ?? '',
      constraints: input.constraints ?? null,
      status: 'exploring',
      selectedCandidateId: null,
      researchBrief: null,
      category: input.category?.trim() || null,
      createdAt: now,
      updatedAt: now,
    };
    this.repo.createSession(session);
    return session;
  }

  listSessions(): TopicSessionDto[] {
    return this.repo.listSessions();
  }

  getSessionDetail(sessionId: string): { session: TopicSessionDto; candidates: TopicCandidateDto[]; messages: TopicMessageDto[] } | null {
    const session = this.repo.getSession(sessionId);
    if (!session) return null;
    return {
      session,
      candidates: this.repo.listCandidates(sessionId),
      messages: this.repo.listMessages(sessionId),
    };
  }

  updateSession(sessionId: string, patch: Partial<Pick<TopicSessionDto, 'title' | 'status' | 'discipline' | 'constraints' | 'selectedCandidateId' | 'category'>>): TopicSessionDto | null {
    return this.repo.updateSession(sessionId, patch);
  }

  deleteSession(sessionId: string): boolean {
    const session = this.repo.getSession(sessionId);
    if (!session) return false;
    this.repo.updateSession(sessionId, { status: 'archived' });
    return true;
  }

  updateCandidate(sessionId: string, candidateId: string, patch: Partial<TopicCandidateDto>): TopicCandidateDto | null {
    const candidate = this.repo.getCandidate(candidateId);
    if (!candidate || candidate.sessionId !== sessionId) return null;
    const next = { ...candidate, ...patch, updatedAt: Date.now() };
    this.repo.upsertCandidate(next);
    return next;
  }

  /**
   * 选题对话:用户消息落库 → 历史+系统提示交给 agent(真实检索工具白名单)→
   * 回答中的结构化块确定性入库 → 助手消息落库。模型/网络失败时,用户消息
   * 已保留,已成功阶段不丢。
   */
  async chat(input: { sessionId: string; message: string; signal?: AbortSignal; projectId?: string }): Promise<{
    ok: true; answer: string; appliedBlocks: string[]; session: TopicSessionDto; candidates: TopicCandidateDto[];
  } | { ok: false; code: string; message?: string }> {
    const session = this.repo.getSession(input.sessionId);
    if (!session) return { ok: false, code: 'session_not_found' };
    const now = Date.now();
    this.repo.appendMessage({ id: `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`, sessionId: session.id, role: 'user', content: input.message, createdAt: now });
    const history = this.repo.listMessages(session.id)
      .filter((message) => message.role !== 'system')
      .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
    if (history.length === 0 || history[history.length - 1]!.content !== input.message) {
      // 极端兜底:落库失败时也把本轮内容送入模型(不静默丢用户输入)。
      history.push({ role: 'user', content: input.message });
    }
    let answer: string;
    try {
      const response = await this.options.runTurn({
        sessionId: `topic_${session.id}`,
        messages: history,
        skillPrompt: buildTopicSystemPrompt(session),
        allowedTools: TOPIC_SEARCH_TOOLS,
        maxTurns: MAX_CHAT_TURNS,
        signal: input.signal,
        projectId: input.projectId ?? session.sourceProjectId ?? undefined,
      });
      if (response.status !== 'completed') {
        const diagnostic = response.diagnostics?.[0];
        return {
          ok: false,
          code: diagnostic?.code ?? response.status,
          message: diagnostic?.message ?? `选题研究轮未完成(${response.status});已收到的研究内容已保留。`,
        };
      }
      answer = response.answer;
    } catch (error) {
      return { ok: false, code: 'turn_failed', message: String(error instanceof Error ? error.message : error).slice(0, 400) };
    }
    const appliedBlocks = this.applyStructuredBlocks(session.id, answer);
    const cleaned = stripTopicBlocks(answer) || answer;
    this.repo.appendMessage({ id: `msg_${randomUUID().replace(/-/g, '').slice(0, 20)}`, sessionId: session.id, role: 'assistant', content: cleaned, createdAt: Date.now() });
    this.repo.updateSession(session.id, {});
    return {
      ok: true,
      answer: cleaned,
      appliedBlocks,
      session: this.repo.getSession(session.id)!,
      candidates: this.repo.listCandidates(session.id),
    };
  }

  /** 确定性解析回答中的结构化块并入库;返回应用成功的块类型。 */
  private applyStructuredBlocks(sessionId: string, answer: string): string[] {
    const applied: string[] = [];
    const session = this.repo.getSession(sessionId);
    if (!session) return applied;
    for (const { block } of extractTopicStructuredBlocks(answer)) {
      try {
        if (block.type === 'candidates_update' && Array.isArray(block.candidates)) {
          const existing = this.repo.listCandidates(sessionId);
          for (const candidate of block.candidates) {
            const match = existing.find((item) => item.title.trim() === candidate.title.trim())
              ?? (candidate.id ? existing.find((item) => item.id === candidate.id) : undefined);
            const now = Date.now();
            const merged: TopicCandidateDto = {
              id: match?.id ?? `cand_${randomUUID().replace(/-/g, '').slice(0, 20)}`,
              sessionId,
              title: candidate.title,
              researchQuestion: candidate.researchQuestion ?? match?.researchQuestion ?? '',
              summary: candidate.summary ?? match?.summary ?? '',
              rationale: candidate.rationale ?? match?.rationale ?? '',
              existingResearch: candidate.existingResearch ?? match?.existingResearch ?? '',
              researchGap: candidate.researchGap ?? match?.researchGap ?? '',
              theoreticalAngles: candidate.theoreticalAngles ?? match?.theoreticalAngles ?? [],
              methodOptions: candidate.methodOptions ?? match?.methodOptions ?? [],
              dataOptions: candidate.dataOptions ?? match?.dataOptions ?? [],
              noveltyAnalysis: candidate.noveltyAnalysis ?? match?.noveltyAnalysis ?? '',
              feasibilityAnalysis: candidate.feasibilityAnalysis ?? match?.feasibilityAnalysis ?? '',
              risks: candidate.risks ?? match?.risks ?? [],
              closestStudies: candidate.closestStudies ?? match?.closestStudies ?? [],
              evidenceRefs: candidate.evidenceRefs ?? match?.evidenceRefs ?? [],
              status: candidate.status ?? match?.status ?? 'candidate',
              projectId: match?.projectId ?? null,
              scenarioId: match?.scenarioId ?? null,
              convertedAt: match?.convertedAt ?? null,
              createdAt: match?.createdAt ?? now,
              updatedAt: now,
            };
            this.repo.upsertCandidate(merged);
          }
          applied.push('candidates_update');
        } else if (block.type === 'research_landscape' && block.landscape) {
          // 研究版图累积保存到会话(researchBrief 字段在选定期前复用存版图,选定期写入正式 brief)。
          const previous = session.status === 'selected' || session.status === 'converted' ? '' : (session.researchBrief ?? '');
          this.repo.updateSession(sessionId, { researchBrief: (previous ? `${previous}\n\n---\n\n` : '') + block.landscape });
          applied.push('research_landscape');
        } else if (block.type === 'selection' && block.selectedTitle) {
          const candidates = this.repo.listCandidates(sessionId);
          const match = candidates.find((item) => item.title.trim() === block.selectedTitle!.trim());
          if (match) {
            this.repo.updateSession(sessionId, { status: 'selected', selectedCandidateId: match.id });
            this.repo.upsertCandidate({ ...match, status: 'selected', updatedAt: Date.now() });
            applied.push('selection');
          }
        } else if (block.type === 'status_update' && block.sessionStatus) {
          this.repo.updateSession(sessionId, { status: block.sessionStatus });
          applied.push('status_update');
        }
      } catch (error) {
        console.warn('[topic] failed to apply structured block:', error instanceof Error ? error.message : error);
      }
    }
    return applied;
  }

  /** 用户显式确认选题:候选置 selected + 生成正式 Topic Research Brief。 */
  selectCandidate(sessionId: string, candidateId: string): { ok: true; session: TopicSessionDto; candidate: TopicCandidateDto; brief: TopicResearchBrief } | { ok: false; code: string } {
    const session = this.repo.getSession(sessionId);
    const candidate = this.repo.getCandidate(candidateId);
    if (!session) return { ok: false, code: 'session_not_found' };
    if (!candidate || candidate.sessionId !== sessionId) return { ok: false, code: 'candidate_not_found' };
    const now = Date.now();
    const updated = this.repo.updateSession(sessionId, { status: 'selected', selectedCandidateId: candidateId });
    const updatedCandidate: TopicCandidateDto = { ...candidate, status: 'selected', updatedAt: now };
    this.repo.upsertCandidate(updatedCandidate);
    const brief = buildResearchBrief(updated ?? session, updatedCandidate);
    this.repo.updateSession(sessionId, { researchBrief: JSON.stringify(brief, null, 2) });
    return {
      ok: true,
      session: this.repo.getSession(sessionId)!,
      candidate: { ...updatedCandidate },
      brief,
    };
  }

  /** 候选转换为项目(provenance):记录 projectId/scenarioId/convertedAt。
   *  任务1（§七）：只校验引用完整性（项目必须存在），防止悬挂 projectId。 */
  markConverted(candidateId: string, refs: { projectId?: string; scenarioId?: string }): TopicCandidateDto | null {
    const candidate = this.repo.getCandidate(candidateId);
    if (!candidate) return null;
    const next: TopicCandidateDto = {
      ...candidate,
      status: 'converted',
      projectId: refs.projectId ?? candidate.projectId,
      scenarioId: refs.scenarioId ?? candidate.scenarioId,
      convertedAt: Date.now(),
      updatedAt: Date.now(),
    };
    this.repo.upsertCandidate(next);
    return next;
  }

  /**
   * 任务1（§七）：候选 → 项目的一次性事务化转换。
   * 创建 Project + 标记候选（convertedAt/provenance）在同一 SQLite 事务内完成：
   * 任一步失败整体回滚，不再可能出现「项目已建但候选未标记」或反向的悬挂状态。
   * 原 markConverted IPC（两步式）保留兼容；新 UI 应迁移到此方法。
   */
  convertCandidateToProject(
    candidateId: string,
    input: { title?: string; researchQuestion?: string; discipline?: string; scenarioId?: string },
  ): { ok: true; project: Project; candidate: TopicCandidateDto } | { ok: false; code: string } {
    const candidate = this.repo.getCandidate(candidateId);
    if (!candidate) return { ok: false, code: 'candidate_not_found' };
    const research = this.options.researchRepository?.();
    if (!research) return { ok: false, code: 'research_repository_unavailable' };

    const now = Date.now();
    const project: Project = {
      id: `project-topic-${now.toString(36)}-${randomUUID().replace(/-/g, '').slice(0, 6)}`,
      title: (input.title?.trim() || candidate.title || '未命名项目').slice(0, 200),
      originalIntent: candidate.summary ?? '',
      researchQuestion: (input.researchQuestion ?? candidate.researchQuestion ?? '').slice(0, 2000),
      lifecycle: 'draft',
      methodology: '',
      discipline: input.discipline?.trim() ?? '',
      metadata: { source: 'topic_conversion', topicCandidateId: candidateId },
      createdAt: now,
      updatedAt: now,
      archivedAt: null,
      version: 1,
      source: 'user',
      deletedAt: null,
    };
    const converted = this.repo.runInTransaction(() => {
      research.createProject(project);
      const marked = this.markConverted(candidateId, {
        projectId: project.id,
        scenarioId: input.scenarioId,
      });
      if (!marked) throw new Error('candidate_marking_failed');
      return marked;
    });
    return { ok: true, project, candidate: converted };
  }

  getBrief(sessionId: string): TopicResearchBrief | null {
    const session = this.repo.getSession(sessionId);
    if (!session?.researchBrief?.trim().startsWith('{')) return null;
    try {
      const parsed = TopicResearchBriefSchema.safeParse(JSON.parse(session.researchBrief));
      return parsed.success ? parsed.data : null;
    } catch {
      return null;
    }
  }
}

/** 从会话+候选生成结构化 Research Brief(v2 02 第二十节;不把聊天记录整段塞给下游)。 */
export function buildResearchBrief(session: TopicSessionDto, candidate: TopicCandidateDto): TopicResearchBrief {
  const checked = TopicResearchBriefSchema.safeParse({
    source: 'topic',
    topicSessionId: session.id,
    candidateId: candidate.id,
    title: candidate.title,
    originalIntent: session.initialIntent,
    researchQuestion: candidate.researchQuestion,
    discipline: session.discipline,
    researchBackground: candidate.summary,
    rationale: candidate.rationale,
    literatureLandscape: (session.researchBrief ?? '').startsWith('{') ? '' : (session.researchBrief ?? ''),
    mainResearchStreams: candidate.theoreticalAngles,
    majorDebates: [],
    researchGap: candidate.researchGap,
    closestStudies: candidate.closestStudies,
    theoreticalAngles: candidate.theoreticalAngles,
    methodologySuggestions: candidate.methodOptions,
    dataSuggestions: candidate.dataOptions,
    constraints: session.constraints,
    risks: candidate.risks,
    targetPublication: session.constraints?.targetPublications ?? [],
    evidenceRefs: candidate.evidenceRefs,
    userDecisions: '',
    createdAt: Date.now(),
  });
  if (!checked.success) {
    throw new Error(`topic brief validation failed: ${checked.error.issues.slice(0, 3).map((issue) => issue.path.join('.')).join(',')}`);
  }
  return checked.data;
}

