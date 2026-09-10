import React, { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import ModelThinkingSelector from '../components/ModelThinkingSelector';
import { AssistantTurn, UserTurn } from '../conversation/ConversationTurns';
import { StreamingMarkdown } from '../presentation/StreamingMarkdown';
import '../conversation/conversation.css';
import { autoResizeTextarea } from '../lib/textareaAutosize.js';
import { isScenarioCompileActive, onScenarioCompileUpdate } from '../lib/scenarioCompileCoordinator.js';
import { FilePlus2, FileUp, History, MessageSquarePlus, RotateCcw, Send, Sparkles, Trash2, X } from 'lucide-react';


export interface ScenarioAssistantActionResult {
  ok: boolean;
  message: string;
}

/** 会话身份：由助手维护，随编译指令一并交给工作台透传给主进程持久化。 */
export interface ScenarioAssistantIdentity {
  projectId?: string | null;
  scenarioId?: string | null;
  conversationId?: string | null;
  /** 思考强度（fast/standard/deep）：随编译请求传给主进程注入提示词。 */
  thinkingLevel?: string;
  /** 已上传申报书模板的模板 ID：存在时编译指令按申报书栏目组织交付物。 */
  fundingTemplateId?: string | null;
  /** 模板栏目结构摘要文本：编译时注入指令前缀。 */
  fundingStructureText?: string | null;
}

type ConversationMessage = {
  id: number | string;
  role: 'assistant' | 'user';
  content: string;
};

type ConversationUnit = {
  id: string;
  title: string;
  messageCount: number;
  createdAt: number;
  updatedAt: number;
};

interface Props {
  zh: boolean;
  scenarioName: string;
  materialNames: readonly string[];
  busy: boolean;
  canUndo: boolean;
  /** 当前项目与场景标识；两者齐备且桥可用时启用持久化会话历史。 */
  projectId?: string | null;
  scenarioId?: string | null;
  onSubmitInstruction(instruction: string, identity: ScenarioAssistantIdentity): Promise<ScenarioAssistantActionResult>;
  onUploadMaterials(): Promise<ScenarioAssistantActionResult>;
  /** 上传申报书模板（2026-09-01 刘总要求）：分析后返回模板 ID 与栏目结构摘要。 */
  onUploadFundingTemplate?(): Promise<{ ok: boolean; message: string; templateId?: string; structureSummary?: string }>;
  /** 场景产出自动回填（2026-09-01 刘总要求）：按模板栏目生成逐栏填写草稿。 */
  onGenerateFundingDraft?(request: { projectId: string; templateId: string; materialText?: string }): Promise<{ ok: boolean; message: string }>;
  onUndo(): void;
}

function initialMessage(zh: boolean, scenarioName: string): ConversationMessage {
  return {
    id: 0,
    role: 'assistant',
    content: zh
      ? `我是场景配置助手。告诉我你想完成什么，我会把对话中的要求直接写入「${scenarioName || '当前场景'}」的交付物、连续 Workflow 和 Scenario Metis.md；右侧会同步显示每一项改动。`
      : `I am the Scenario Configuration Assistant. Tell me what you need, and I will write it into the deliverable, continuous Workflow, and Scenario Metis.md for “${scenarioName || 'this scenario'}”. The right pane updates with every change.`,
  };
}

function formatTime(timestamp: number, zh: boolean): string {
  return new Date(timestamp).toLocaleString(zh ? 'zh-CN' : 'en-US', { hour12: false });
}

/** 把实时执行事件压缩成一行用户可读的阶段描述；进度类高频事件跳过。 */
function compileEventSummary(payload: unknown, zh: boolean): string | null {
  if (typeof payload !== 'object' || payload === null) return null;
  const inner = (payload as { event?: unknown }).event;
  if (typeof inner !== 'object' || inner === null) return null;
  const event = inner as Record<string, unknown>;
  const text = (value: unknown) => (typeof value === 'string' ? value.trim().slice(0, 160) : '');
  if (event.type === 'lifecycle') {
    const summary = text(event.summary);
    if (summary) return summary;
    const phase = typeof event.phase === 'string' ? event.phase : '';
    if (phase === 'started') return zh ? 'AI 开始执行编译任务' : 'AI started the compilation';
    if (phase === 'completed') return zh ? '本轮执行完成' : 'Run finished';
    if (phase === 'failed') return zh ? '本轮执行失败' : 'Run failed';
    if (phase === 'interrupted') return zh ? '执行被中断' : 'Run interrupted';
    return null;
  }
  if (event.type === 'action') {
    return text(event.summary) || text(event.label) || text(event.action) || null;
  }
  if (event.type === 'tool_result') {
    const toolName = text(event.toolName);
    if (!toolName) return null;
    return event.status === 'failed'
      ? (zh ? `工具 ${toolName} 执行失败` : `Tool ${toolName} failed`)
      : (zh ? `工具 ${toolName} 已返回结果` : `Tool ${toolName} returned`);
  }
  return null;
}

export default function ScenarioConfigurationAssistant({
  zh,
  scenarioName,
  materialNames,
  busy,
  canUndo,
  projectId,
  scenarioId,
  onSubmitInstruction,
  onUploadMaterials,
  onUploadFundingTemplate,
  onGenerateFundingDraft,
  onUndo,
}: Props) {
  const [draft, setDraft] = useState('');
  const [messages, setMessages] = useState<ConversationMessage[]>(() => [initialMessage(zh, scenarioName)]);
  // 申报书模板上下文（2026-09-01 刘总要求）：上传后记录模板 ID 与结构摘要，
  // 之后的每轮编译指令都会按模板栏目组织交付物；编译完成后自动生成逐栏填写草稿。
  const [fundingTemplateId, setFundingTemplateId] = useState<string | null>(null);
  const [fundingTemplateSummary, setFundingTemplateSummary] = useState<string | null>(null);
  const [fundingBusy, setFundingBusy] = useState(false);
  const [sending, setSending] = useState(false);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const sequence = useRef(1);
  // 会话历史（仅当项目+场景标识齐备且桥接存在时可用）。
  const persistenceReady = Boolean(projectId && scenarioId);
  const [conversationId, setConversationId] = useState<string | null>(null);
  const [conversations, setConversations] = useState<ConversationUnit[]>([]);
  const [historyOpen, setHistoryOpen] = useState(false);
  const headerRef = useRef<HTMLElement | null>(null);
  // 抽屉锚定几何：门户渲染到 body，空间不够时翻转到头部上方，绝不被祖先 overflow 裁剪。
  const [drawerStyle, setDrawerStyle] = useState<React.CSSProperties | null>(null);
  const computeDrawerStyle = useCallback((): React.CSSProperties | null => {
    const header = headerRef.current;
    if (!header) return null;
    const rect = header.getBoundingClientRect();
    const MAX_H = 300;
    const spaceBelow = window.innerHeight - rect.bottom - 6;
    const spaceAbove = rect.top - 6;
    const below = spaceBelow >= 120 || spaceBelow >= spaceAbove;
    const maxHeight = Math.max(120, Math.min(MAX_H, below ? spaceBelow : spaceAbove));
    const style: React.CSSProperties = {
      position: 'fixed',
      left: Math.max(8, rect.left),
      width: Math.min(rect.width, window.innerWidth - 16),
      maxHeight,
      zIndex: 1000,
    };
    if (below) style.top = rect.bottom + 6;
    else style.bottom = window.innerHeight - rect.top + 6;
    return style;
  }, []);
  const toggleHistory = useCallback(() => {
    if (historyOpen) { setHistoryOpen(false); setDrawerStyle(null); return; }
    setDrawerStyle(computeDrawerStyle());
    setHistoryOpen(true);
  }, [historyOpen, computeDrawerStyle]);
  // 抽屉打开期间跟随窗口 resize/scroll 重算锚定位置（setState 仅发生在事件回调里）。
  useLayoutEffect(() => {
    if (!historyOpen) return;
    const recompute = () => { setDrawerStyle(computeDrawerStyle()); };
    window.addEventListener('resize', recompute);
    window.addEventListener('scroll', recompute, true);
    return () => { window.removeEventListener('resize', recompute); window.removeEventListener('scroll', recompute, true); };
  }, [historyOpen, computeDrawerStyle]);
  // 实时执行阶段（思考/工具过程）：编译期间由主进程推送，完成后保留供回看。
  const [stages, setStages] = useState<string[]>([]);
  const [elapsedSeconds, setElapsedSeconds] = useState(0);
  // token 级流式尾部：实时展示模型正在写出的推理/内容片段。
  const [streamTail, setStreamTail] = useState<{ reasoning: string; content: string }>({ reasoning: '', content: '' });
  const append = (role: ConversationMessage['role'], content: string) => {
    setMessages((current) => [...current, { id: `local-${sequence.current++}`, role, content }]);
  };
  // 输入框随内容自动增高，最多约 10 行，超出后内部滚动。
  useEffect(() => {
    if (textareaRef.current) autoResizeTextarea(textareaRef.current);
  }, [draft]);

  // 订阅主进程推送的编译执行事件（思考/工具过程），等待期间实时显示。
  useEffect(() => {
    const subscribe = typeof window !== 'undefined' ? window.metis?.onScenarioCompileEvent : undefined;
    if (!subscribe) return;
    return subscribe((payload: unknown) => {
      const summary = compileEventSummary(payload, zh);
      if (summary) setStages((previous) => [...previous.slice(-7), summary]);
    });
  }, [zh]);

  // 订阅 token 流：保留最近的推理与内容尾部，让用户看到 AI 正在写什么。
  useEffect(() => {
    const subscribe = typeof window !== 'undefined' ? window.metis?.onScenarioStreamChunk : undefined;
    if (!subscribe) return;
    return subscribe((chunk) => {
      // P0 2026-09-06：移除 400 字双重截断——完整累积交给 StreamingMarkdown
      // 增量渲染（frozen prefix 不重复解析）；上限仅作内存保护。
      setStreamTail((previous) => {
        const reasoning = typeof chunk.reasoning === 'string' && chunk.reasoning
          ? (previous.reasoning + chunk.reasoning).slice(-8_000)
          : previous.reasoning;
        const content = typeof chunk.content === 'string' && chunk.content
          ? (previous.content + chunk.content).slice(-20_000)
          : previous.content;
        return { reasoning, content };
      });
    });
  }, []);

  // 等待计时：让用户明确知道 AI 正在工作而不是卡死。
  useEffect(() => {
    // eslint-disable-next-line react-hooks/set-state-in-effect -- reset elapsed timer when a run finishes
    if (!(busy || sending)) { setElapsedSeconds(0); return; }
    const timer = window.setInterval(() => setElapsedSeconds((seconds) => seconds + 1), 1000);
    return () => window.clearInterval(timer);
  }, [busy, sending]);

  // 后台编译重挂接（2026-08-25 刘总要求）：用户切页后编译在后台继续；
  // 回到场景页时若该场景仍有在途编译，自动恢复「生成中」状态并在完成时
  // 追加结果消息。历史（含未完成轮）由主进程落库，可随时从历史记录找回。
  useEffect(() => {
    if (!scenarioId) return;
    if (!isScenarioCompileActive(scenarioId)) return;
    // eslint-disable-next-line react-hooks/set-state-in-effect -- restore the visible pending state when reattaching to an external in-flight compile
    setSending(true);
    const off = onScenarioCompileUpdate(scenarioId, (state) => {
      if (!state.done) return;
      setSending(false);
      append('assistant', state.ok
        ? (state.summary || '后台编译已完成，场景已自动保存。') + (state.autosaved ? '（已自动保存。）' : '')
        : `后台编译未完成：${state.summary ?? '未知原因'}。本轮指令已存入历史记录，可重新发起。`);
    });
    return off;
    // 场景切换通过 key 重挂载完成；append 为稳定 setter。
  }, [scenarioId]);

  const bridges = useCallback(() => {
    const metis = typeof window !== 'undefined' ? window.metis : undefined;
    if (!persistenceReady || !metis) return null;
    if (!metis.scenarioConversationUnits || !metis.scenarioConversationCreate
      || !metis.scenarioConversationDelete || !metis.scenarioConversationMessages) return null;
    return {
      projectId: projectId!,
      scenarioId: scenarioId!,
      units: metis.scenarioConversationUnits,
      create: metis.scenarioConversationCreate,
      remove: metis.scenarioConversationDelete,
      messages: metis.scenarioConversationMessages,
    };
  }, [persistenceReady, projectId, scenarioId]);

  const refreshConversations = useCallback(async (): Promise<ConversationUnit[]> => {
    const bridge = bridges();
    if (!bridge) return [];
    try {
      const units = await bridge.units({ projectId: bridge.projectId, scenarioId: bridge.scenarioId });
      setConversations(units ?? []);
      return units ?? [];
    } catch {
      setConversations([]);
      return [];
    }
  }, [bridges]);

  const loadConversationMessages = useCallback(async (targetId: string): Promise<boolean> => {
    const bridge = bridges();
    if (!bridge) return false;
    try {
      const rows = await bridge.messages({ projectId: bridge.projectId, conversationId: targetId });
      const visible = (rows ?? [])
        .filter((row): row is typeof row & { role: 'user' | 'assistant' } => row.role === 'user' || row.role === 'assistant')
        .map((row) => ({ id: row.id, role: row.role, content: row.content }));
      setMessages((current) => [current[0] ?? initialMessage(zh, scenarioName), ...visible]);
      return true;
    } catch {
      return false;
    }
  }, [bridges, scenarioName, zh]);

  // 打开抽屉时加载会话列表；首次进入时自动载入最近一个会话，保证历史在重启后仍在。
  useEffect(() => {
    if (!persistenceReady) return;
    let cancelled = false;
    void (async () => {
      const units = await refreshConversations();
      if (cancelled || units.length === 0) return;
      const newest = units[0]!;
      setConversationId(newest.id);
      await loadConversationMessages(newest.id);
    })();
    return () => { cancelled = true; };
    // 场景切换通过 key 重挂载完成；这里只在挂载时执行一次。
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const startNewConversation = async () => {
    const bridge = bridges();
    if (!bridge || sending || busy) return;
    try {
      const created = await bridge.create({ projectId: bridge.projectId, scenarioId: bridge.scenarioId });
      if (!created?.id) return;
      setConversationId(created.id);
      setMessages([initialMessage(zh, scenarioName)]);
      await refreshConversations();
    } catch {
      // 创建失败时保持当前会话不变；不伪称已新建。
    }
  };

  const removeConversation = async (unitId: string) => {
    const bridge = bridges();
    if (!bridge || sending) return;
    try {
      const removed = await bridge.remove({ projectId: bridge.projectId, conversationId: unitId });
      if (!removed) return;
      if (unitId === conversationId) {
        setConversationId(null);
        setMessages([initialMessage(zh, scenarioName)]);
      }
      await refreshConversations();
    } catch {
      // 删除失败保持现状；不伪称已删除。
    }
  };

  const selectConversation = async (unitId: string) => {
    if (sending) return;
    setConversationId(unitId);
    const loaded = await loadConversationMessages(unitId);
    if (!loaded) setConversationId(null);
  };

  const submit = async () => {
    const instruction = draft.trim();
    if (!instruction || sending || busy) return;
    setDraft('');
    setSending(true);
    setStages([]);
    setStreamTail({ reasoning: '', content: '' });
    append('user', instruction);
    try {
      // 首条消息前惰性创建会话；创建失败则本轮退化为内存态（如实不落库）。
      let activeConversationId = conversationId;
      const bridge = bridges();
      if (bridge && !activeConversationId) {
        try {
          const created = await bridge.create({ projectId: bridge.projectId, scenarioId: bridge.scenarioId });
          if (created?.id) {
            activeConversationId = created.id;
            setConversationId(created.id);
          }
        } catch {
          activeConversationId = null;
        }
      }
      let thinkingLevel: string | undefined;
      try { thinkingLevel = localStorage.getItem('metis:thinking-level') ?? undefined; } catch { /* 隐私模式下不传 */ }
      const result = await onSubmitInstruction(instruction, {
        projectId: projectId ?? null,
        scenarioId: scenarioId ?? null,
        conversationId: activeConversationId,
        thinkingLevel,
        fundingTemplateId,
        fundingStructureText: fundingTemplateSummary,
      });
      // 申报书闭环（2026-09-01 刘总要求）：场景编译成功且绑定了申报书模板时，
      // 自动按模板栏目生成逐栏填写草稿并作为助手消息插入对话。
      if (result.ok && fundingTemplateId && projectId && onGenerateFundingDraft) {
        try {
          const draftResult = await onGenerateFundingDraft({ projectId, templateId: fundingTemplateId, materialText: fundingTemplateSummary ?? undefined });
          append('assistant', draftResult.message);
        } catch {
          append('assistant', zh ? '填写草稿自动生成未完成；可稍后在申报书面板中手动生成。' : 'Automatic draft generation did not finish.');
        }
      }
      if (result.ok && activeConversationId && bridges()) {
        // 主进程在成功后已把本轮 user+assistant 落库；以数据库为准刷新视图。
        const synced = await loadConversationMessages(activeConversationId);
        if (!synced) append('assistant', result.message);
      } else {
        // 失败或无会话：本轮不会持久化；保留乐观指令并如实显示失败通知（不落库）。
        append('assistant', result.message);
      }
      if (bridge && activeConversationId) await refreshConversations();
    } catch {
      // The workbench should normally convert operational failures into a
      // concrete result. This fallback only reports an unhandled transport
      // failure and never claims that the draft changed.
      append('assistant', zh ? '场景编译服务未完成，当前草稿没有改变。' : 'The scenario compiler did not finish; the current draft was not changed.');
    } finally {
      setSending(false);
    }
  };

  const upload = async () => {
    if (sending || busy) return;
    setSending(true);
    try {
      const result = await onUploadMaterials();
      append('assistant', result.message);
    } catch {
      append('assistant', zh ? '材料导入未完成，当前草稿没有改变。' : 'Material import did not finish; the current draft was not changed.');
    } finally {
      setSending(false);
    }
  };

  // 上传申报书模板：分析保存后把结构摘要注入助手上下文，并提示用户直接说需求。
  const uploadFundingTemplate = async () => {
    if (!onUploadFundingTemplate || sending || busy || fundingBusy) return;
    setFundingBusy(true);
    try {
      const result = await onUploadFundingTemplate();
      if (result.ok && result.templateId) {
        setFundingTemplateId(result.templateId);
        if (result.structureSummary) setFundingTemplateSummary(result.structureSummary);
        append('assistant', `${result.message}${result.structureSummary ? `

${result.structureSummary}` : ''}

${zh ? '现在直接输入你的要求（例如：帮我生成这份申报书的完整填写场景），我会按模板栏目组织场景交付物；场景写完后自动生成逐栏填写草稿。' : 'Now describe what you need; I will organize deliverables around these sections and auto-draft the application after the run.'}`);
      } else {
        append('assistant', result.message);
      }
    } catch {
      append('assistant', zh ? '申报书模板上传未完成。' : 'Template upload did not finish.');
    } finally {
      setFundingBusy(false);
    }
  };

  const prefillSuggestion = (instruction: string) => {
    setDraft(instruction);
    textareaRef.current?.focus();
  };

  const isBusy = busy || sending;
  const suggestions = zh
    ? ['帮我从零构建一个研究场景', '根据当前材料完善交付物和结构', '检查并补全连续 Workflow']
    : ['Build a research scenario from scratch', 'Use the current material to complete the deliverable', 'Review and complete the continuous Workflow'];

  return <aside className="scenario-assistant" aria-label={zh ? '场景配置助手' : 'Scenario configuration assistant'} data-testid="sw-configuration-assistant">
    <header className="scenario-assistant__header" ref={headerRef}>
      <span className="scenario-assistant__mark"><Sparkles size={15} /></span>
      <div><h2>{zh ? '场景配置助手' : 'Scenario assistant'}</h2><p>{zh ? '对话构建，右侧同步成型' : 'Build in conversation, review on the right'}</p></div>
      <button
        type="button"
        className="scenario-assistant__history-toggle"
        onClick={toggleHistory}
        aria-expanded={historyOpen}
        title={persistenceReady ? (zh ? '查看会话历史' : 'View conversation history') : (zh ? '请先在项目中打开该页面；打开项目后对话历史会按项目保存并可在此查看。' : 'Open a project first; conversations are saved per project and listed here.')}
        aria-label={zh ? '查看会话历史' : 'View conversation history'}
        data-testid="sw-assistant-history-toggle"
      ><History size={15} />{zh ? '历史记录' : 'History'}</button>
    </header>

    {historyOpen && createPortal(<section className="scenario-assistant__drawer" style={drawerStyle ?? undefined} aria-label={zh ? '会话历史' : 'Conversation history'} data-testid="sw-assistant-drawer">
      <header>
        <strong>{zh ? '会话历史' : 'History'}</strong>
        <div>
          <button type="button" onClick={() => void startNewConversation()} disabled={isBusy || !persistenceReady} aria-label={zh ? '新建对话' : 'New conversation'} data-testid="sw-assistant-new-conversation"><MessageSquarePlus size={14} />{zh ? '新建对话' : 'New'}</button>
          <button type="button" onClick={() => setHistoryOpen(false)} aria-label={zh ? '收起会话历史' : 'Collapse history'} data-testid="sw-assistant-drawer-close"><X size={14} /></button>
        </div>
      </header>
      {!persistenceReady
        ? <p>{zh ? '对话历史按项目保存。请先在顶部打开一个科研项目，再回到这里查看历史记录。' : 'Conversation history is saved per project. Open a research project first, then come back to view history here.'}</p>
        : conversations.length === 0
        ? <p>{zh ? '这个场景还没有保存的对话；发送第一条消息后会自动创建。' : 'No saved conversations for this scenario yet; one is created with your first message.'}</p>
        : <ul>
            {conversations.map((unit, index) => <li key={unit.id} className={unit.id === conversationId ? 'active' : ''}>
              <button type="button" onClick={() => void selectConversation(unit.id)} aria-label={zh ? `载入对话 ${unit.title || '未命名对话'}` : `Load conversation ${unit.title || 'Untitled'}`} data-testid="sw-conversation-item">
                <strong>{unit.title || (zh ? '未命名对话' : 'Untitled')}</strong>
                <span>{index === 0 ? (zh ? '当前 · ' : 'Current · ') : ''}{formatTime(unit.updatedAt, zh)} · {zh ? `${unit.messageCount} 条` : `${unit.messageCount} msg(s)`}</span>
              </button>
              <button type="button" onClick={() => void removeConversation(unit.id)} disabled={isBusy} aria-label={zh ? `删除对话 ${unit.title || '未命名对话'}` : `Delete conversation ${unit.title || 'Untitled'}`} data-testid="sw-conversation-delete"><Trash2 size={13} /></button>
            </li>)}
          </ul>}
    </section>, document.body)}
    <div className="scenario-assistant__conversation" aria-live="polite">
      {messages.map((message) => (
        message.role === 'user'
          ? <UserTurn key={message.id} message={{ id: String(message.id), role: 'user', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
          : <AssistantTurn key={message.id} message={{ id: String(message.id), role: 'assistant', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
      ))}
      {isBusy && <article className="scenario-assistant__message scenario-assistant__message--assistant scenario-assistant__message--pending">
        <span>METIS</span>
        <p>{zh ? '正在将本轮要求编译到场景草稿…' : 'Compiling this turn into the scenario draft…'}</p>
        <div className="scenario-assistant__stages" data-testid="sw-assistant-stages" aria-live="polite">
          {stages.slice(-4).map((stage, index) => <small key={index + '-' + stage}>{stage}</small>)}
          {streamTail.reasoning && (
            <details className="scenario-assistant__stream-tail" title={zh ? '模型推理流' : 'Model reasoning stream'}>
              <summary><small>{zh ? '思考中…' : 'Reasoning…'}</small></summary>
              <small>{streamTail.reasoning}</small>
            </details>
          )}
          {streamTail.content && (
            <div className="scenario-assistant__stream-content" title={zh ? '输出流' : 'Output stream'}>
              <StreamingMarkdown text={streamTail.content} streaming locale={zh ? 'zh' : 'en'} />
            </div>
          )}
          <small>{zh ? '已用时 ' + elapsedSeconds + ' 秒' : elapsedSeconds + 's elapsed'}</small>
        </div>
      </article>}
    </div>

    <div className="scenario-assistant__suggestions" aria-label={zh ? '对话示例' : 'Conversation examples'}>
      {suggestions.map((suggestion) => <button type="button" key={suggestion} onClick={() => prefillSuggestion(suggestion)} disabled={isBusy}>{suggestion}</button>)}
    </div>

    {materialNames.length > 0 && <div className="scenario-assistant__materials" aria-label={zh ? '已导入材料' : 'Imported materials'}>
      <span>{zh ? `材料 ${materialNames.length}` : `${materialNames.length} material(s)`}</span>
      <p title={materialNames.join(' · ')}>{materialNames.join(' · ')}</p>
    </div>}

    <div className="scenario-assistant__composer">
      <textarea
        ref={textareaRef}
        value={draft}
        rows={4}
        disabled={isBusy}
        onChange={(event) => setDraft(event.target.value)}
        onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void submit(); } }}
        placeholder={zh ? '例如：我要写一篇 12,000 字的实证论文，先搭建研究问题与证据框架，再形成完整正文…' : 'For example: I need a 12,000-word empirical paper: frame the research question and evidence first, then write the full paper…'}
        aria-label={zh ? '输入场景构建要求' : 'Enter scenario-building requirements'}
        data-testid="sw-assistant-input"
      />
      <footer className="scenario-assistant__composer-tools" data-testid="sw-assistant-toolbar">
        <button type="button" className="scenario-assistant__tool-icon" onClick={() => void upload()} disabled={isBusy} title={zh ? '添加材料' : 'Add material'} aria-label={zh ? '添加材料' : 'Add material'} data-testid="sw-assistant-upload"><FilePlus2 size={15} /></button>
        {onUploadFundingTemplate && <button type="button" className="scenario-assistant__tool-icon" onClick={() => void uploadFundingTemplate()} disabled={isBusy || fundingBusy} title={zh ? '上传申报书模板（PDF/DOCX）：分析后按栏目组织场景，写完自动生成填写草稿' : 'Upload a funding application template (PDF/DOCX)'} aria-label={zh ? '上传申报书模板' : 'Upload funding template'} data-testid="sw-assistant-upload-funding"><FileUp size={15} /></button>}
        {fundingTemplateId && <span className="scenario-assistant__funding-badge" title={fundingTemplateSummary ?? fundingTemplateId} style={{ fontSize: 11, color: 'var(--text-secondary)', alignSelf: 'center' }}>{zh ? '已绑定申报书模板' : 'Template bound'}</span>}
        <button type="button" className="scenario-assistant__tool-icon" onClick={onUndo} disabled={!canUndo || isBusy} title={zh ? '撤销 AI 修改' : 'Undo AI change'} aria-label={zh ? '撤销 AI 修改' : 'Undo AI change'} data-testid="sw-assistant-undo"><RotateCcw size={14} /></button>
        <ModelThinkingSelector zh={zh} disabled={isBusy} labeled />
        <span className="scenario-assistant__composer-spacer" />
        <button type="button" className="scenario-assistant__send" onClick={() => void submit()} disabled={!draft.trim() || isBusy} aria-label={zh ? '发送场景要求' : 'Send scenario requirement'} data-testid="sw-assistant-send"><Send size={15} /></button>
      </footer>
    </div>
  </aside>;
}
