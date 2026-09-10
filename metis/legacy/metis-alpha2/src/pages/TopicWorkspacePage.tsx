import React from 'react';
import { AssistantTurn, UserTurn } from '../conversation/ConversationTurns';
import { StreamingMarkdown } from '../presentation/StreamingMarkdown';
import { ChevronRight, Plus } from 'lucide-react';
import './TopicWorkspacePage.css';
import type { TopicCandidateDto, TopicResearchBrief, TopicSessionDto } from '../../engine/runtime/TopicRuntimeContract.js';
import { researchWorkspaceStore } from '../research/researchWorkspaceStore.js';
import { setPendingScenarioHandoff } from '../topic/scenarioHandoff.js';
import ChatbotCollabPanel from '../topic/ChatbotCollabPanel';
import ModelThinkingSelector from '../components/ModelThinkingSelector';
import SplitHandle from '../components/SplitHandle';
import { buildTopicContextPackage } from '../topic/contextPackage';
import type { ExternalModelReference } from '../../engine/runtime/ExternalReferenceContract.js';

/**
 * 选题 Topic Workspace(2026-09-04 刘总要求:选题一级功能)。
 * 布局:主区顶部=会话 tab 条(按分类分组,可切换/关闭,「+」新建);中=AI 研究过程
 * (真实检索/研究版图/结构化选择);右=候选池(可折叠)。
 * 复用 METIS 桌面工作台设计(高信息密度、克制、无卡片墙/评分圆环)。
 */

const SESSION_STATUS_LABELS: Record<string, string> = {
  exploring: '意向确认中', researching: '检索研究中', comparing: '候选比较中',
  selected: '选题已确定', converted: '已转项目', archived: '已归档',
};

const CANDIDATE_STATUS_LABELS: Record<string, string> = {
  candidate: '候选', shortlisted: '已收藏', selected: '已选定', rejected: '已排除', converted: '已转项目',
};

interface TopicStreamChunk { sessionId: string; content: string; reasoning?: string; isFinished: boolean }

function makeId(prefix: string): string {
  return `${prefix}-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 8)}`;
}

function EvidenceList({ refs }: { refs: TopicCandidateDto['evidenceRefs'] }) {
  if (refs.length === 0) return null;
  return (
    <ul className="topic-evidence">
      {refs.slice(0, 6).map((ref, index) => (
        <li key={`${ref.title}-${index}`}>
          {ref.title}
          {ref.authors && ref.authors.length > 0 ? `(${ref.authors.slice(0, 3).join(',')}${ref.authors.length > 3 ? '等' : ''})` : ''}
          {ref.year ? ` ${ref.year}` : ''}
          {ref.venue ? `·${ref.venue}` : ''}
          {ref.url ? <a href={ref.url} target="_blank" rel="noreferrer"> 链接</a> : ref.doi ? <span> DOI:{ref.doi}</span> : null}
          {ref.claim ? <small> 支持:{ref.claim}</small> : null}
        </li>
      ))}
      {refs.length > 6 && <li>{`等 ${refs.length} 条证据`}</li>}
    </ul>
  );
}

export default function TopicWorkspacePage() {
  const [sessions, setSessions] = React.useState<TopicSessionDto[]>([]);
  const [activeSessionId, setActiveSessionId] = React.useState<string | null>(null);
  const [session, setSession] = React.useState<TopicSessionDto | null>(null);
  const [candidates, setCandidates] = React.useState<TopicCandidateDto[]>([]);
  const [messages, setMessages] = React.useState<Array<{ id: string; role: string; content: string }>>([]);
  const [input, setInput] = React.useState('');
  const [streaming, setStreaming] = React.useState(false);
  const [streamTail, setStreamTail] = React.useState('');
  const [notice, setNotice] = React.useState('');
  const [creating, setCreating] = React.useState(false);
  const [newIntent, setNewIntent] = React.useState('');
  // 会话管理(2026-09 刘总:tab 化 + 分类/重命名/删除)。
  const [newCategory, setNewCategory] = React.useState(''); // '' = 未分类;'__new__' = 输入新分类
  const [newCategoryCustom, setNewCategoryCustom] = React.useState('');
  const [renaming, setRenaming] = React.useState(false);
  const [renameDraft, setRenameDraft] = React.useState('');
  const [categoryEditing, setCategoryEditing] = React.useState(false);
  const [categoryDraft, setCategoryDraft] = React.useState('');
  const [rightCollapsed, setRightCollapsed] = React.useState(false);
  const [activeCandidateId, setActiveCandidateId] = React.useState<string | null>(null);
  const [projectCreating, setProjectCreating] = React.useState(false);
  // Chatbot 协作视图（2026-09-05 刘总规格书）：临时双栏，关闭即退出嵌入。
  const [chatbotOpen, setChatbotOpen] = React.useState(false);
  // P0-4 scoped external refs: refs belong to ONE scope (projectId + topic
  // session). On scope change the state resets immediately (refs cleared,
  // status loading) and every async return is discarded unless its generation
  // still matches — a slow or failed request can never leak Topic A refs into
  // Topic B's context package.
  type ExternalRefsStatus = 'idle' | 'loading' | 'ready' | 'error';
  interface ExternalRefsState {
    scopeKey: string;
    status: ExternalRefsStatus;
    refs: ExternalModelReference[];
  }
  const externalRefsScopeKey = React.useCallback((projectId: string | null, sessionId: string | null): string =>
    `${projectId ?? 'global'}::${sessionId ?? 'none'}`, []);
  const [externalRefsState, setExternalRefsState] = React.useState<ExternalRefsState>({ scopeKey: 'global::none', status: 'idle', refs: [] });
  const externalRefsGeneration = React.useRef(0);
  const [chatbotSplit, setChatbotSplit] = React.useState<number>(() => {
    try {
      const value = Number(window.localStorage.getItem('metis-chatbot-split-v2'));
      return Number.isFinite(value) && value >= 0.4 && value <= 0.45 ? value : 0.42;
    } catch { return 0.42; }
  });
  const collabWrapRef = React.useRef<HTMLDivElement>(null);
  React.useEffect(() => {
    try { window.localStorage.setItem('metis-chatbot-split-v2', String(chatbotSplit)); } catch { /* best-effort */ }
  }, [chatbotSplit]);
  const applySplitFromClientX = React.useCallback((clientX: number) => {
    const rect = collabWrapRef.current?.getBoundingClientRect();
    if (!rect || rect.width <= 0) return;
    const ratio = (rect.right - clientX) / rect.width;
    setChatbotSplit(Math.min(0.45, Math.max(0.4, ratio)));
  }, []);
  const syncChatbotBounds = React.useCallback(() => {
    // 松手后按新尺寸恢复嵌入视图（拖动期间已隐藏）。
    window.dispatchEvent(new CustomEvent('metis:restore-embedded-views'));
  }, []);
  const sessionIdRef = React.useRef<string | null>(null);
  React.useEffect(() => {
    sessionIdRef.current = activeSessionId;
  }, [activeSessionId]);

  // 会话切换时收起重命名/分类编辑态,避免串到下一个会话。
  React.useEffect(() => {
    setRenaming(false);
    setCategoryEditing(false);
  }, [activeSessionId]);

  // tab 条按分类分组:归档(软删除)会话不显示;无分类归入「未分类」组。
  const visibleSessions = sessions.filter((item) => item.status !== 'archived');
  const categories = [...new Set(visibleSessions.map((item) => item.category?.trim() ?? '').filter((name) => name.length > 0))];
  const sessionGroups: Array<{ name: string | null; items: TopicSessionDto[] }> = [
    ...categories.map((name) => ({ name, items: visibleSessions.filter((item) => (item.category?.trim() ?? '') === name) })),
    { name: null, items: visibleSessions.filter((item) => !(item.category?.trim())) },
  ].filter((group) => group.items.length > 0);

  const refreshExternalRefs = React.useCallback(async (scope?: { sessionId?: string | null; projectId?: string | null }) => {
    // 任务2 上下文隔离：只取当前选题会话（+其来源项目）捕获的外部参考。
    // 空 scope 的全局拉取已被 runtime 禁止（scope_required）——那会把其他
    // Topic/Project 的 Chatbot 引用串进本会话上下文。
    const sessionId = scope?.sessionId ?? sessionIdRef.current;
    const projectId = scope?.projectId ?? session?.sourceProjectId ?? null;
    const scopeKey = externalRefsScopeKey(projectId, sessionId);
    const generation = ++externalRefsGeneration.current;
    // Scope 切换第一时间清空旧 refs 并置 loading——旧 scope 的引用绝不跨 scope 存活。
    setExternalRefsState({ scopeKey, status: 'loading', refs: [] });
    if (!sessionId) { setExternalRefsState({ scopeKey, status: 'ready', refs: [] }); return; }
    try {
      const result = await window.metis?.externalRefList?.({
        sessionId,
        ...(projectId ? { projectId } : {}),
        limit: 50,
      });
      if (generation !== externalRefsGeneration.current) return; // 晚到的旧 scope 响应：丢弃
      if (result?.ok && result.references) setExternalRefsState({ scopeKey, status: 'ready', refs: result.references });
      else setExternalRefsState({ scopeKey, status: result ? 'error' : 'error', refs: [] }); // 失败：明确 error，绝不保留旧数据
    } catch {
      if (generation !== externalRefsGeneration.current) return;
      setExternalRefsState({ scopeKey, status: 'error', refs: [] });
    }
  }, [externalRefsScopeKey, session?.sourceProjectId]);

  const refreshSessions = React.useCallback(async () => {
    try {
      const rows = await window.metis?.topicListSessions?.();
      setSessions((rows ?? []).filter((row): row is TopicSessionDto => Boolean(row && typeof (row as { id?: unknown }).id === 'string')));
    } catch { setSessions([]); }
  }, []);

  const loadSession = React.useCallback(async (id: string) => {
    try {
      const detail = await window.metis?.topicGetSession?.(id);
      if (!detail) return;
      setSession(detail.session as unknown as TopicSessionDto);
      setCandidates((detail.candidates ?? []) as unknown as TopicCandidateDto[]);
      setMessages((detail.messages ?? []).map((message) => ({ id: String((message as { id: string }).id), role: String((message as { role: string }).role), content: String((message as { content: string }).content) })));
    } catch { /* 加载失败保留当前状态 */ }
  }, []);

  React.useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- one-shot session list load
    void refreshSessions();
  }, [refreshSessions]);

  // 任务2 上下文隔离：会话/项目切换时按新 scope 重新拉取外部参考，
  // 保证 context package 只含当前 Topic（+来源项目）的引用。
  React.useEffect(() => {
    void refreshExternalRefs();
  }, [refreshExternalRefs, activeSessionId]);

  React.useEffect(() => {
    const unsubscribe = window.metis?.onTopicStreamChunk?.((chunk: TopicStreamChunk) => {
      if (chunk.sessionId !== sessionIdRef.current) return; // 事件按会话隔离
      // P0 2026-09-05：保存完整累积内容交给 StreamingMarkdown 增量渲染
      // （旧版截断 400 字导致用户看不到完整流式回答）。上限仅作内存保护：
      // 超限时尾部截断会触发解析器一代重置，单帧全量解析，可接受。
      setStreamTail((previous) => {
        const next = previous + (chunk.content ?? '');
        return next.length > 20_000 ? next.slice(-20_000) : next;
      });
    });
    return () => unsubscribe?.();
  }, []);

  const buildPackage = React.useCallback((): string | null => buildTopicContextPackage({
    hasSession: Boolean(session),
    sessionTitle: session?.title ?? null,
    sessionStatus: session ? (SESSION_STATUS_LABELS[session.status] ?? session.status) : null,
    candidates: candidates.map((candidate) => ({
      title: candidate.title,
      status: CANDIDATE_STATUS_LABELS[candidate.status] ?? candidate.status,
    })),
    messages: messages.map((message) => ({ role: message.role, content: message.content })),
    // P0-4：进入 LLM Context 的引用必须与当前工作区 scope 完全一致——
    // loading/error/旧 scope 状态下一律不带 externalReferences。
    externalReferences: externalRefsState.status === 'ready'
      && externalRefsState.scopeKey === externalRefsScopeKey(session?.sourceProjectId ?? null, sessionIdRef.current)
      ? externalRefsState.refs.map((ref) => ({ model: ref.model, quotedText: ref.quotedText }))
      : [],
  }), [session, candidates, messages, externalRefsState, externalRefsScopeKey]);

  const handleReferenceConfirmed = React.useCallback((reference: ExternalModelReference, duplicate: boolean) => {
    setExternalRefsState((current) => {
      const scopeKey = externalRefsScopeKey(session?.sourceProjectId ?? null, sessionIdRef.current);
      if (current.scopeKey !== scopeKey) return current; // scope 已切换：新引用属于旧 scope，丢弃
      if (current.refs.some((item) => item.contextDigest === reference.contextDigest)) return current;
      return { ...current, status: 'ready', refs: [reference, ...current.refs] };
    });
    setMessages((current) => [...current, {
      id: `extref-${reference.id}`,
      role: 'assistant',
      content: [
        `外部参考·非证据｜来源：${reference.model}（${reference.url}）`,
        reference.quotedText.length > 600 ? `${reference.quotedText.slice(0, 600)}…` : reference.quotedText,
        duplicate ? '（内容指纹重复，未重复入库）' : '已存入外部参考库（external_references）。该内容不进入证据链，仅供选题论证参考。',
      ].join('\n'),
    }]);
  }, []);

  const createSession = async () => {
    const intent = newIntent.trim();
    if (!intent) return;
    // 新建时可直接挂到某个分类:「新建分类…」走自定义输入,空=未分类。
    const category = newCategory === '__new__' ? newCategoryCustom.trim() : newCategory.trim();
    const result = await window.metis?.topicCreateSession?.({ initialIntent: intent, ...(category ? { category } : {}) });
    if (result?.ok && result.session) {
      const session = result.session as unknown as TopicSessionDto;
      setCreating(false);
      setNewIntent('');
      setNewCategory('');
      setNewCategoryCustom('');
      await refreshSessions();
      setActiveSessionId(session.id);
      await loadSession(session.id);
      // 首条意图自动发起研究(不重复询问用户已给出的信息)。
      void sendFirstMessage(session.id, intent);
    } else {
      setNotice(result?.code === 'persistence_unavailable' ? '持久化暂不可用,无法创建选题会话。' : '创建选题会话失败,请重试。');
    }
  };

  // 删除(tab 关闭/会话栏按钮共用):二次确认;后端为软删除(归档),tab 条不再显示。
  const deleteSessionWithConfirm = async (item: TopicSessionDto) => {
    if (!window.confirm(`确定删除选题会话「${item.title}」?删除后不再出现在标签页中。`)) return;
    await window.metis?.topicDeleteSession?.(item.id);
    if (activeSessionId === item.id) {
      setActiveSessionId(null);
      setSession(null);
      setCandidates([]);
      setMessages([]);
    }
    await refreshSessions();
  };

  const submitRename = async () => {
    const title = renameDraft.trim();
    if (!title || !session) { setRenaming(false); return; }
    await window.metis?.topicUpdateSession?.({ sessionId: session.id, patch: { title } });
    setRenaming(false);
    await refreshSessions();
    await loadSession(session.id);
  };

  // 分类下拉:'' = 未分类;'__new__' = 展开输入框新建分类。
  const applyCategory = async (value: string) => {
    if (!session) return;
    if (value === '__new__') { setCategoryDraft(''); setCategoryEditing(true); return; }
    await window.metis?.topicUpdateSession?.({ sessionId: session.id, patch: { category: value === '' ? null : value } });
    await refreshSessions();
    await loadSession(session.id);
  };

  const submitNewCategory = async () => {
    const name = categoryDraft.trim();
    if (!name || !session) { setCategoryEditing(false); return; }
    await window.metis?.topicUpdateSession?.({ sessionId: session.id, patch: { category: name } });
    setCategoryEditing(false);
    await refreshSessions();
    await loadSession(session.id);
  };

  const sendFirstMessage = async (id: string, intent: string) => {
    setStreaming(true);
    setStreamTail('');
    try {
      const result = await window.metis?.topicChat?.({ sessionId: id, message: intent });
      if (result?.ok) {
        await loadSession(id);
        setNotice('');
      } else {
        setNotice(`选题研究轮未完成:${result?.message ?? result?.code ?? '未知原因'}。已记录的内容已保留。`);
        await loadSession(id);
      }
    } finally {
      setStreaming(false);
      setStreamTail('');
    }
  };

  const send = async () => {
    const message = input.trim();
    if (!message || !activeSessionId || streaming) return;
    setInput('');
    setMessages((current) => [...current, { id: makeId('local'), role: 'user', content: message }]);
    setStreaming(true);
    setStreamTail('');
    try {
      const result = await window.metis?.topicChat?.({ sessionId: activeSessionId, message });
      if (result?.ok) {
        await loadSession(activeSessionId);
        setNotice('');
      } else {
        setNotice(`本轮未完成:${result?.message ?? result?.code ?? '未知原因'}。已收到的研究内容已保留,可直接重发或继续。`);
        await loadSession(activeSessionId);
      }
    } finally {
      setStreaming(false);
      setStreamTail('');
    }
  };

  const updateCandidateStatus = async (candidateId: string, status: 'shortlisted' | 'rejected' | 'candidate') => {
    if (!activeSessionId) return;
    await window.metis?.topicUpdateCandidate?.({ sessionId: activeSessionId, candidateId, patch: { status } });
    await loadSession(activeSessionId);
  };

  const confirmSelection = async (candidate: TopicCandidateDto) => {
    if (!activeSessionId) return;
    const result = await window.metis?.topicSelectCandidate?.({ sessionId: activeSessionId, candidateId: candidate.id });
    if (result?.ok) {
      await loadSession(activeSessionId);
      await refreshSessions();
      setNotice('选题已确认。可以基于选题构建场景,或直接创建科研项目。');
    } else {
      setNotice(`确认选题失败:${result?.code ?? '未知原因'}`);
    }
  };

  const activeCandidate = candidates.find((candidate) => candidate.id === activeCandidateId) ?? candidates.find((candidate) => candidate.status === 'selected') ?? null;
  const selectedCandidate = candidates.find((candidate) => candidate.status === 'selected') ?? null;

  const buildScenario = async () => {
    if (!selectedCandidate || !session) return;
    // 优先后端生成的正式结构化 Brief;不可用时回退为前端最小 Brief(不阻塞 handoff)。
    let brief: TopicResearchBrief;
    try {
      const stored = await window.metis?.topicGetBrief?.(session.id) as TopicResearchBrief | null | undefined;
      brief = stored ?? {
        source: 'topic', topicSessionId: session.id, candidateId: selectedCandidate.id,
        title: selectedCandidate.title, originalIntent: session.initialIntent,
        researchQuestion: selectedCandidate.researchQuestion, discipline: session.discipline,
        researchBackground: selectedCandidate.summary, rationale: selectedCandidate.rationale,
        literatureLandscape: '', mainResearchStreams: selectedCandidate.theoreticalAngles,
        majorDebates: [], researchGap: selectedCandidate.researchGap,
        closestStudies: selectedCandidate.closestStudies, theoreticalAngles: selectedCandidate.theoreticalAngles,
        methodologySuggestions: selectedCandidate.methodOptions, dataSuggestions: selectedCandidate.dataOptions,
        constraints: session.constraints, risks: selectedCandidate.risks,
        targetPublication: session.constraints?.targetPublications ?? [],
        evidenceRefs: selectedCandidate.evidenceRefs, userDecisions: '', createdAt: Date.now(),
      };
    } catch {
      return;
    }
    setPendingScenarioHandoff({ title: selectedCandidate.title, brief });
    window.dispatchEvent(new CustomEvent('metis:open-personalization'));
  };

  const createProjectDirectly = async () => {
    if (!selectedCandidate || !session || projectCreating) return;
    setProjectCreating(true);
    try {
      const projectId = `proj-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`;
      const result = await researchWorkspaceStore.getState().createProject({
        projectId,
        title: selectedCandidate.title.slice(0, 120),
        originalIntent: session.initialIntent.slice(0, 4000),
        researchQuestion: selectedCandidate.researchQuestion.slice(0, 1500),
        methodology: selectedCandidate.methodOptions.join('、').slice(0, 800),
        discipline: session.discipline.slice(0, 100),
      });
      if (result.success && result.resourceId) {
        // Scenario 绑定:沿用当前项目创建的偏好写入方式(任务3多对话架构将正式化为 defaultScenarioId)。
        await window.metis?.topicMarkConverted?.({ candidateId: selectedCandidate.id, projectId: result.resourceId });
        researchWorkspaceStore.getState().setActiveProject(result.resourceId);
        window.dispatchEvent(new CustomEvent('metis:navigate-projects'));
        setNotice('科研项目已创建,已进入项目工作台。');
      } else {
        setNotice('科研项目创建失败。选题与场景数据均保留,可重试。');
      }
    } catch {
      setNotice('科研项目创建失败。选题与场景数据均保留,可重试。');
    } finally {
      setProjectCreating(false);
    }
  };

  const workspaceNode = (
    <div className={`topic-workspace${chatbotOpen ? ' topic-workspace--collab' : ''}`} data-testid="topic-workspace">
      <section className="topic-workspace__main" aria-label="选题研究过程">
        <header className="topic-workspace__tabs" role="tablist" aria-label="选题会话">
          <div className="topic-workspace__tabs-scroll">
            {sessionGroups.map((group) => (
              <span className="topic-workspace__tab-group" key={group.name ?? 'uncategorized'}>
                {categories.length > 0 && (
                  <span className="topic-workspace__tab-group-label">{group.name ?? '未分类'}</span>
                )}
                {group.items.map((item) => (
                  <span key={item.id} className={`topic-workspace__tab${item.id === activeSessionId ? ' active' : ''}`}>
                    <button
                      type="button"
                      role="tab"
                      aria-selected={item.id === activeSessionId}
                      title={`${item.title} · ${SESSION_STATUS_LABELS[item.status] ?? item.status}`}
                      data-session-id={item.id}
                      onClick={() => { setActiveSessionId(item.id); void loadSession(item.id); }}
                      data-testid={`topic-session-${item.id}`}
                    >
                      {item.title}
                    </button>
                    <button
                      type="button"
                      className="topic-workspace__tab-close"
                      aria-label={`删除 ${item.title}`}
                      onClick={() => void deleteSessionWithConfirm(item)}
                    >
                      ×
                    </button>
                  </span>
                ))}
              </span>
            ))}
            {visibleSessions.length === 0 && <span className="topic-workspace__tabs-empty">还没有选题会话。</span>}
          </div>
          <span className="topic-workspace__header-actions">
            <button type="button" className="btn-secondary btn-sm" onClick={() => setCreating((value) => !value)} data-testid="topic-new">
              <Plus size={13} /> 新选题
            </button>
            <button
              type="button"
              className="btn-secondary btn-sm"
              onClick={() => setChatbotOpen(true)}
              data-testid="topic-open-chatbot"
              title="打开 Chatbot 协作面板：与其他 AI 并排讨论，内容仅作外部参考（非证据）"
            >
              打开 Chatbot
            </button>
          </span>
        </header>
        {creating && (
          <div className="topic-workspace__new">
            <textarea
              rows={4}
              value={newIntent}
              placeholder="例如:我想研究生成式人工智能对知识劳动者的影响,偏劳动社会学,想投 CSSCI,但具体题目还没想好。"
              onChange={(event) => setNewIntent(event.target.value)}
              data-testid="topic-new-intent"
            />
            <span className="topic-workspace__new-row">
              <select value={newCategory} onChange={(event) => setNewCategory(event.target.value)} data-testid="topic-new-category" aria-label="新建会话分类">
                <option value="">未分类</option>
                {categories.map((name) => <option key={name} value={name}>{name}</option>)}
                <option value="__new__">＋新建分类…</option>
              </select>
              {newCategory === '__new__' && (
                <input
                  value={newCategoryCustom}
                  placeholder="新分类名"
                  onChange={(event) => setNewCategoryCustom(event.target.value)}
                  data-testid="topic-new-category-custom"
                />
              )}
              <button type="button" className="btn-primary btn-sm" disabled={!newIntent.trim() || (newCategory === '__new__' && !newCategoryCustom.trim())} onClick={() => void createSession()} data-testid="topic-create-submit">开始选题研究</button>
            </span>
          </div>
        )}
        {session && (
          <div className="topic-workspace__sessionbar" data-testid="topic-sessionbar">
            <small>{SESSION_STATUS_LABELS[session.status] ?? session.status}</small>
            {renaming ? (
              <input
                value={renameDraft}
                autoFocus
                onChange={(event) => setRenameDraft(event.target.value)}
                onKeyDown={(event) => { if (event.key === 'Enter') void submitRename(); if (event.key === 'Escape') setRenaming(false); }}
                onBlur={() => void submitRename()}
                data-testid="topic-session-rename-input"
              />
            ) : (
              <button type="button" className="btn-secondary btn-sm" onClick={() => { setRenameDraft(session.title); setRenaming(true); }} data-testid="topic-session-rename">重命名</button>
            )}
            <label>
              分类
              <select value={session.category?.trim() ?? ''} onChange={(event) => void applyCategory(event.target.value)} data-testid="topic-session-category">
                <option value="">未分类</option>
                {categories.map((name) => <option key={name} value={name}>{name}</option>)}
                <option value="__new__">＋新建分类…</option>
              </select>
            </label>
            {categoryEditing && (
              <>
                <input
                  value={categoryDraft}
                  autoFocus
                  placeholder="新分类名"
                  onChange={(event) => setCategoryDraft(event.target.value)}
                  onKeyDown={(event) => { if (event.key === 'Enter') void submitNewCategory(); if (event.key === 'Escape') setCategoryEditing(false); }}
                  data-testid="topic-session-category-new"
                />
                <button type="button" className="btn-secondary btn-sm" disabled={!categoryDraft.trim()} onClick={() => void submitNewCategory()}>确定</button>
              </>
            )}
            <button type="button" className="btn-secondary btn-sm" onClick={() => void deleteSessionWithConfirm(session)} data-testid="topic-session-delete">删除</button>
          </div>
        )}
        {session && (session.status === 'selected' || session.status === 'converted') && (
          <div className="topic-workspace__selected-banner" data-testid="topic-selected-banner">
            <span>选题已确定:《{selectedCandidate?.title ?? session.title}》</span>
            <span className="topic-workspace__banner-actions">
              <button type="button" className="btn-primary btn-sm" onClick={() => void buildScenario()} data-testid="topic-build-scenario">基于选题构建场景</button>
              <button type="button" className="btn-secondary btn-sm" disabled={projectCreating} onClick={() => void createProjectDirectly()} data-testid="topic-create-project">直接创建科研项目</button>
              <button type="button" className="btn-secondary btn-sm" onClick={() => window.metis?.topicUpdateSession?.({ sessionId: session.id, patch: { status: 'comparing' } }).then(() => loadSession(session.id))}>继续完善</button>
            </span>
          </div>
        )}
        {notice && <div className="topic-workspace__notice" role="status">{notice}</div>}
        <div className="topic-workspace__messages">
          {messages.length === 0 && !session && (
            <div className="topic-workspace__intro">
              <h2>选题</h2>
              <p>从一个模糊的研究兴趣开始，METIS 会真实检索中英文文献，和你一起比较候选、确认选题。</p>
              <p className="topic-workspace__intro-note">第一步：点上方「+ 新选题」，用一句话描述你的研究兴趣。</p>
            </div>
          )}
          {messages.map((message) => (
            message.role === 'user'
              ? <UserTurn key={message.id} message={{ id: message.id, role: 'user', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
              : <AssistantTurn key={message.id} message={{ id: message.id, role: 'assistant', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
          ))}
          {streaming && (
            <div className="conv-assistant" data-status="streaming">
              <div className="conv-assistant__body">
                {streamTail
                  ? <StreamingMarkdown text={streamTail} streaming locale="zh" />
                  : <span style={{ color: 'var(--conversation-muted)', fontSize: 13 }}>正在检索与研究……</span>}
                <span className="conv-caret" aria-hidden>▌</span>
              </div>
            </div>
          )}
        </div>
        <footer className="topic-workspace__input">
          {/* 刘总 2026-09：选题对话与研究对话一样支持选择模型与思考强度。 */}
          <div className="topic-workspace__input-tools">
            <ModelThinkingSelector zh labeled disabled={!session || streaming} />
          </div>
          <div className="topic-workspace__input-row">
            <textarea
              rows={2}
              value={input}
              placeholder={session ? '继续讨论:例如「A 和 C 哪个更好?」「我没有企业数据」「就这个。」' : '先点上方「+ 新选题」创建会话。'}
              onChange={(event) => setInput(event.target.value)}
              onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(); } }}
              disabled={!session || streaming}
              data-testid="topic-input"
            />
            <button type="button" className="btn-primary btn-sm" disabled={!session || streaming || !input.trim()} onClick={() => void send()} data-testid="topic-send">发送</button>
          </div>
        </footer>
      </section>

      <aside className={`topic-workspace__candidates${rightCollapsed ? ' collapsed' : ''}`} aria-label="候选选题池">
        <header>
          <strong>候选选题({candidates.length})</strong>
          <button type="button" className="btn-secondary btn-sm" onClick={() => setRightCollapsed((value) => !value)} aria-label={rightCollapsed ? '展开候选池' : '折叠候选池'}>
            <ChevronRight size={13} className={rightCollapsed ? undefined : 'rotated'} />
          </button>
        </header>
        {!rightCollapsed && (
          <>
            <ul className="topic-workspace__candidate-list">
              {candidates.map((candidate) => (
                <li key={candidate.id} className={candidate.id === activeCandidateId ? 'active' : undefined}>
                  <button type="button" onClick={() => setActiveCandidateId(candidate.id)} data-testid={`topic-candidate-${candidate.id}`}>
                    <strong>{candidate.title}</strong>
                    <small>{CANDIDATE_STATUS_LABELS[candidate.status] ?? candidate.status}{candidate.noveltyAnalysis ? ` · ${candidate.noveltyAnalysis.slice(0, 40)}` : ''}</small>
                  </button>
                </li>
              ))}
              {candidates.length === 0 && <li className="topic-workspace__empty">检索完成后,候选选题会出现在这里。</li>}
            </ul>
            {activeCandidate && (
              <div className="topic-workspace__candidate-detail" data-testid="topic-candidate-detail">
                <h3>{activeCandidate.title}</h3>
                {activeCandidate.researchQuestion && <p><strong>研究问题:</strong>{activeCandidate.researchQuestion}</p>}
                {activeCandidate.summary && <p>{activeCandidate.summary}</p>}
                {activeCandidate.rationale && <p><strong>选题理由:</strong>{activeCandidate.rationale}</p>}
                {activeCandidate.existingResearch && <p><strong>已有研究:</strong>{activeCandidate.existingResearch}</p>}
                {activeCandidate.researchGap && <p><strong>研究空间:</strong>{activeCandidate.researchGap}</p>}
                {activeCandidate.theoreticalAngles.length > 0 && <p><strong>理论切口:</strong>{activeCandidate.theoreticalAngles.join(';')}</p>}
                {activeCandidate.methodOptions.length > 0 && <p><strong>方法选项:</strong>{activeCandidate.methodOptions.join(';')}</p>}
                {activeCandidate.dataOptions.length > 0 && <p><strong>数据选项:</strong>{activeCandidate.dataOptions.join(';')}</p>}
                {activeCandidate.noveltyAnalysis && <p><strong>创新空间:</strong>{activeCandidate.noveltyAnalysis}</p>}
                {activeCandidate.feasibilityAnalysis && <p><strong>可行性:</strong>{activeCandidate.feasibilityAnalysis}</p>}
                {activeCandidate.risks.length > 0 && <p><strong>风险:</strong>{activeCandidate.risks.join(';')}</p>}
                <EvidenceList refs={activeCandidate.evidenceRefs} />
                <div className="topic-workspace__candidate-actions">
                  {activeCandidate.status === 'candidate' && (
                    <>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'shortlisted')}>收藏</button>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'rejected')}>排除</button>
                      <button type="button" className="btn-primary btn-sm" onClick={() => void confirmSelection(activeCandidate)} data-testid="topic-confirm-candidate">确定这个选题</button>
                    </>
                  )}
                  {activeCandidate.status === 'shortlisted' && (
                    <>
                      <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'candidate')}>取消收藏</button>
                      <button type="button" className="btn-primary btn-sm" onClick={() => void confirmSelection(activeCandidate)}>确定这个选题</button>
                    </>
                  )}
                  {activeCandidate.status === 'rejected' && (
                    <button type="button" className="btn-secondary btn-sm" onClick={() => void updateCandidateStatus(activeCandidate.id, 'candidate')}>恢复候选</button>
                  )}
                  {activeCandidate.status === 'selected' && <span className="topic-workspace__selected-tag">已选定</span>}
                </div>
              </div>
            )}
          </>
        )}
      </aside>
    </div>
  );

  if (!chatbotOpen) return workspaceNode;

  return (
    <div className="topic-collab" data-testid="topic-collab" ref={collabWrapRef}>
      {workspaceNode}
      <SplitHandle
        label="拖动调整 Chatbot 面板宽度（40%–45%）"
        testId="chatbot-split-handle"
        onDragStart={() => { void window.metis?.collabHide?.(); }}
        onDrag={(clientX) => applySplitFromClientX(clientX)}
        onDragEnd={() => syncChatbotBounds()}
        onKeyDelta={(delta) => {
          const rect = collabWrapRef.current?.getBoundingClientRect();
          const width = rect && rect.width > 0 ? rect.width : 1;
          setChatbotSplit((ratio) => Math.min(0.45, Math.max(0.4, ratio + delta / width)));
        }}
      />
      <ChatbotCollabPanel
        zh
        buildContextPackage={buildPackage}
        projectId={session?.sourceProjectId ?? null}
        sessionId={activeSessionId}
        splitRatio={chatbotSplit}
        onSplitRatioChange={setChatbotSplit}
        onReferenceConfirmed={handleReferenceConfirmed}
        onClose={() => setChatbotOpen(false)}
      />
    </div>
  );
}
