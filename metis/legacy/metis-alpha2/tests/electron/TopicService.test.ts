import { describe, expect, it } from 'vitest';
import {
  extractTopicStructuredBlocks,
  stripTopicBlocks,
  TopicService,
  type TopicAgentResponse,
  type TopicChatTurnOptions,
} from '../../electron/TopicService.js';
import type { TopicRepository } from '../../electron/TopicRepository.js';
import { TopicCandidateDtoSchema, TopicSessionDtoSchema, type TopicCandidateDto, type TopicMessageDto, type TopicSessionDto } from '../../engine/runtime/TopicRuntimeContract.js';

/** 内存仓库替身(真实 TopicRepository 的接口子集;SQLite 由 electron 层负责)。 */
function createMemoryRepo(): TopicRepository {
  const sessions = new Map<string, TopicSessionDto>();
  const candidates = new Map<string, TopicCandidateDto>();
  const messages: TopicMessageDto[] = [];
  const repo = {
    createSession(session: TopicSessionDto): void {
      sessions.set(session.id, session);
    },
    getSession(id: string): TopicSessionDto | null {
      return sessions.get(id) ?? null;
    },
    listSessions(): TopicSessionDto[] {
      return [...sessions.values()].sort((a, b) => b.updatedAt - a.updatedAt);
    },
    updateSession(id: string, patch: Partial<TopicSessionDto>): TopicSessionDto | null {
      const current = sessions.get(id);
      if (!current) return null;
      const next = { ...current, ...patch, updatedAt: Date.now() };
      sessions.set(id, next);
      return next;
    },
    getCandidate(id: string): TopicCandidateDto | null {
      return candidates.get(id) ?? null;
    },
    listCandidates(sessionId: string): TopicCandidateDto[] {
      return [...candidates.values()].filter((candidate) => candidate.sessionId === sessionId).sort((a, b) => a.createdAt - b.createdAt);
    },
    upsertCandidate(candidate: TopicCandidateDto): void {
      candidates.set(candidate.id, candidate);
    },
    appendMessage(message: TopicMessageDto): void {
      messages.push(message);
    },
    listMessages(sessionId: string): TopicMessageDto[] {
      return messages.filter((message) => message.sessionId === sessionId);
    },
  };
  return repo as unknown as TopicRepository;
}

function baseCandidate(title: string, sessionId: string): TopicCandidateDto {
  const checked = TopicCandidateDtoSchema.safeParse({
    id: `cand_${title}`, sessionId, title,
  });
  if (!checked.success) throw new Error(checked.error.issues.map((issue) => issue.message).join(','));
  return checked.data;
}

describe('Topic structured blocks (2026-09-04 选题模块)', () => {
  it('extracts candidates_update blocks and rejects unknown types', () => {
    const answer = [
      '根据检索结果,提出两个候选。',
      '```json',
      JSON.stringify({ type: 'candidates_update', candidates: [{ title: '生成式AI对知识劳动者技能形成的影响研究', researchQuestion: '生成式AI如何影响知识劳动者的技能形成?' }] }),
      '```',
      '```json',
      JSON.stringify({ type: 'not_a_type', evil: 'payload' }),
      '```',
      '```json',
      'not json at all',
      '```',
    ].join('\n');
    const blocks = extractTopicStructuredBlocks(answer);
    expect(blocks).toHaveLength(1);
    expect(blocks[0]!.block.type).toBe('candidates_update');
    expect(blocks[0]!.block.candidates?.[0]?.title).toContain('技能形成');
  });

  it('stripTopicBlocks removes structured fences from the visible answer', () => {
    const answer = '结论说明\n```json\n{"type":"status_update","sessionStatus":"researching"}\n```\n尾部补充';
    const cleaned = stripTopicBlocks(answer);
    expect(cleaned).not.toContain('status_update');
    expect(cleaned).toContain('结论说明');
    expect(cleaned).toContain('尾部补充');
  });

  it('chat persists the user message even when the model turn fails', async () => {
    const repo = createMemoryRepo();
    const service = new TopicService({
      repository: repo,
      runTurn: async (): Promise<TopicAgentResponse> => ({ status: 'model_error', answer: '' }),
    });
    const session = service.createSession({ initialIntent: '研究生成式AI与知识劳动者,偏劳动社会学,目标CSSCI' });
    const result = await service.chat({ sessionId: session.id, message: '帮我找研究方向' });
    expect(result.ok).toBe(false);
    const detail = service.getSessionDetail(session.id)!;
    expect(detail.messages.some((message) => message.role === 'user' && message.content === '帮我找研究方向')).toBe(true);
  });

  it('chat applies candidates_update deterministically and merges same-title candidates', async () => {
    const repo = createMemoryRepo();
    let call = 0;
    const service = new TopicService({
      repository: repo,
      runTurn: async (options: TopicChatTurnOptions): Promise<TopicAgentResponse> => {
        call += 1;
        expect(options.allowedTools).toContain('search_papers');
        expect(options.allowedTools).toContain('ncpssd_search');
        expect(options.allowedTools).toContain('web_search');
        return {
          status: 'completed',
          answer: [
            '第一轮候选。',
            '```json',
            JSON.stringify({ type: 'candidates_update', candidates: [
              { title: '候选A', researchQuestion: '问题A', noveltyAnalysis: '较明确:近三年无同题研究', feasibilityAnalysis: '较高:公开数据可得', evidenceRefs: [{ title: 'An existing study', year: 2024, doi: '10.1/abc', claim: '说明该方向已有关注但未覆盖X' }] },
              { title: '候选B', researchQuestion: '问题B' },
            ] }),
            '```',
          ].join('\n'),
        };
      },
    });
    void call;
    const session = service.createSession({ initialIntent: '意图' });
    const first = await service.chat({ sessionId: session.id, message: '给我几个候选' });
    expect(first.ok).toBe(true);
    if (!first.ok) return;
    expect(first.appliedBlocks).toContain('candidates_update');
    expect(first.candidates.map((candidate) => candidate.title).sort()).toEqual(['候选A', '候选B']);
    const detail = service.getSessionDetail(session.id)!;
    const candidateA = detail.candidates.find((candidate) => candidate.title === '候选A')!;
    expect(candidateA.evidenceRefs[0]?.doi).toBe('10.1/abc');

    // 第二轮同 title 候选合并(不产生重复),新字段补充进已有候选。
    const secondService = service;
    (secondService as unknown as { options: TopicServiceOptions }).options.runTurn = async (): Promise<TopicAgentResponse> => ({
      status: 'completed',
      answer: '```json\n' + JSON.stringify({ type: 'candidates_update', candidates: [{ title: '候选A', researchGap: '组织条件差异的解释缺口' }] }) + '\n```',
    });
    const second = await secondService.chat({ sessionId: session.id, message: '候选A再论证一下' });
    expect(second.ok).toBe(true);
    const candidatesAfter = service.getSessionDetail(session.id)!.candidates;
    expect(candidatesAfter.filter((candidate) => candidate.title === '候选A')).toHaveLength(1);
    expect(candidatesAfter.find((candidate) => candidate.title === '候选A')?.researchGap).toContain('解释缺口');
    expect(candidatesAfter.find((candidate) => candidate.title === '候选A')?.evidenceRefs[0]?.doi).toBe('10.1/abc');
  });

  it('selectCandidate marks selection and produces a structured research brief', async () => {
    const repo = createMemoryRepo();
    const service = new TopicService({
      repository: repo,
      runTurn: async (): Promise<TopicAgentResponse> => ({
        status: 'completed',
        answer: '```json\n' + JSON.stringify({ type: 'candidates_update', candidates: [
          { title: '平台劳动控制的三类解释机制比较', researchQuestion: '不同组织条件下算法管理与劳动过程控制如何组合?', researchGap: '组织条件差异的解释缺口', methodOptions: ['多案例比较'], noveltyAnalysis: '较明确', feasibilityAnalysis: '较高' },
        ] }) + '\n```',
      }),
    });
    const session = service.createSession({ initialIntent: '平台劳动研究', discipline: '劳动社会学', constraints: { targetPublications: ['CSSCI'] } });
    await service.chat({ sessionId: session.id, message: '开始' });
    const candidate = service.getSessionDetail(session.id)!.candidates[0]!;
    const result = service.selectCandidate(session.id, candidate.id);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.session.status).toBe('selected');
    expect(result.brief.title).toContain('平台劳动控制');
    expect(result.brief.researchQuestion).toContain('组织条件');
    expect(result.brief.targetPublication).toEqual(['CSSCI']);
    expect(result.brief.source).toBe('topic');
    // brief 持久化到会话,getBrief 可恢复。
    const stored = service.getBrief(session.id);
    expect(stored?.candidateId).toBe(candidate.id);
  });

  it('session category persists on create and updates via updateSession (会话分类)', () => {
    const repo = createMemoryRepo();
    const service = new TopicService({
      repository: repo,
      runTurn: async (): Promise<TopicAgentResponse> => ({ status: 'completed', answer: 'ok' }),
    });
    // 旧数据兼容:不传分类 → null(未分类)。
    const legacy = service.createSession({ initialIntent: '意图' });
    expect(legacy.category).toBeNull();
    const categorized = service.createSession({ initialIntent: '意图', category: '劳动研究' });
    expect(categorized.category).toBe('劳动研究');
    const moved = service.updateSession(categorized.id, { category: '平台经济' });
    expect(moved?.category).toBe('平台经济');
    const cleared = service.updateSession(categorized.id, { category: null });
    expect(cleared?.category).toBeNull();
  });

  it('session DTO round-trips through the strict schema (persistence contract)', () => {
    const session = TopicSessionDtoSchema.safeParse({
      id: 'topic_x', title: 't', initialIntent: '', sourceProjectId: null, discipline: '',
      constraints: null, status: 'exploring', selectedCandidateId: null, researchBrief: null,
      createdAt: 1, updatedAt: 1,
    });
    expect(session.success).toBe(true);
  });
});
