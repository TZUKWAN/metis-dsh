import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import type { Components } from 'react-markdown';
import { ArrowLeft, ArrowRight, ExternalLink, PanelLeftClose, PanelLeftOpen, Plus, RotateCw, Sparkles, Star, X } from 'lucide-react';
import SplitHandle from '../components/SplitHandle';
import ModelThinkingSelector from '../components/ModelThinkingSelector';

import { AssistantTurn, UserTurn } from '../conversation/ConversationTurns';
import '../conversation/conversation.css';
import { autoResizeTextarea } from '../lib/textareaAutosize.js';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import { EmptyState, InlineError, QuietLoading, StaleDataNotice } from '../components/async/AsyncFeedback';
import { navigate } from '../shell/navigation';
import './SubmissionWorkspacePage.css';

/**
 * AI-Native Submission Browser Workspace（2026-09-01 刘总规格）：
 * 左：项目成果 + 候选短名单；中：真实浏览器（复用 BrowserService 的
 * WebContentsView——用户与 AI 共享同一会话）；右：投稿参谋对话。
 * 旧的 Case 状态机、期刊调研按钮矩阵全部退出前台；数据层零迁移。
 */

interface OutcomeRow { id: string; title: string; currentVersion: number }
interface Tab { id: string; title: string; url: string }
interface JournalCardData { name: string; tags?: string[]; verdict?: string; fit?: string[]; risks?: string[]; url?: string }
interface ChoiceGroupData { question: string; options: string[]; multi?: boolean; key: string }
interface SubmissionCardData { name: string; note?: string }
interface ChatMessage { id: string; role: 'user' | 'assistant'; content: string }

const DEFAULT_TABS: Array<{ title: string; url: string }> = [
  { title: '万维书刊', url: 'https://www.eshukan.com/' },
  { title: 'LetPub', url: 'https://www.letpub.com.cn/' },
];

function parseFenceJson<T>(code: string): T | null {
  try {
    const value = JSON.parse(code) as T;
    return value && typeof value === 'object' ? value : null;
  } catch {
    return null;
  }
}

function locale(): boolean {
  return true; // 工作区默认中文界面
}

export default function SubmissionWorkspacePage() {
  const projectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const zh = locale();

  const [outcomes, setOutcomes] = useState<OutcomeRow[]>([]);
  const [activeOutcomeId, setActiveOutcomeId] = useState<string | null>(null);
  const [tabs, setTabs] = useState<Tab[]>(() => DEFAULT_TABS.map((tab, index) => ({ id: `tab-${index}`, ...tab })));
  const [activeTabId, setActiveTabId] = useState<string>('tab-0');
  const [addressDraft, setAddressDraft] = useState('');
  const [browserState, setBrowserState] = useState<{ url: string; title: string; canGoBack: boolean; canGoForward: boolean } | null>(null);
  const hostRef = useRef<HTMLDivElement | null>(null);
  const textareaRef = useRef<HTMLTextAreaElement | null>(null);
  const visibleRef = useRef(false);

  const [messages, setMessages] = useState<ChatMessage[]>([]);
  const [draft, setDraft] = useState('');
  const [sending, setSending] = useState(false);
  const [intent, setIntent] = useState<Record<string, unknown>>({});
  const [shortlist, setShortlist] = useState<Array<{ name: string; source?: string }>>([]);
  // 任务4 统一 Async View State：成果列表与短名单的加载失败不再静默。
  const [outcomesState, setOutcomesState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [outcomesStale, setOutcomesStale] = useState(false);
  const [outcomesRetrying, setOutcomesRetrying] = useState(false);
  const [shortlistState, setShortlistState] = useState<'loading' | 'ready' | 'error'>('loading');
  // 任务4：创建投稿记录防双击。
  const [creatingCase, setCreatingCase] = useState(false);

  const loadOutcomesList = useCallback(async () => {
    const metis = window.metis;
    if (!metis?.listOutcomes) return;
    if (!projectId) {
      // 无活动项目：这不是"加载中"，直接进入就绪空态（任务4：禁止用永久 loading 伪装）。
      setOutcomes([]);
      setActiveOutcomeId(null);
      setOutcomesState('ready');
      setOutcomesStale(false);
      return;
    }
    setOutcomesRetrying(true);
    try {
      const rows = await metis.listOutcomes({ projectId, query: '' });
      if (!Array.isArray(rows)) throw new Error('submission outcomes payload invalid');
      const mapped = rows.map((row: { id: string; title: string; currentVersion: number }) => ({ id: row.id, title: row.title, currentVersion: row.currentVersion }));
      setOutcomes(mapped);
      setActiveOutcomeId((current) => current ?? mapped[0]?.id ?? null);
      setOutcomesState('ready');
    } catch (error) {
      console.error('[SubmissionWorkspace] listOutcomes failed:', error);
      // 已有数据（重载失败）时保留旧列表并标 stale；首次失败呈 error + retry。
      setOutcomesState((state) => {
        if (state === 'ready') setOutcomesStale(true);
        else return 'error';
        return 'ready';
      });
    } finally {
      setOutcomesRetrying(false);
    }
  }, [projectId]);

  useEffect(() => {
    void loadOutcomesList();
  }, [loadOutcomesList]);

  // 任务6(2026-09-05):短名单正式持久化(SQLite submission_shortlists),重启恢复。
  useEffect(() => {
    let alive = true;
    if (!projectId || !window.metis?.submissionShortlistList) return () => { alive = false; };
    setShortlistState('loading');
    void window.metis.submissionShortlistList(projectId).then((rows) => {
      if (alive && Array.isArray(rows)) {
        setShortlist(rows.map((row) => ({ name: String(row.name), source: String(row.source || '') })));
        setShortlistState('ready');
      }
    }).catch((error) => {
      console.error('[SubmissionWorkspace] shortlist load failed:', error);
      if (alive) setShortlistState('error');
    });
    return () => { alive = false; };
  }, [projectId]);

  const activeOutcome = useMemo(() => outcomes.find((item) => item.id === activeOutcomeId) ?? null, [outcomes, activeOutcomeId]);

  // ── 三栏布局：宽度可拖拽 + 左栏可收起（2026-09-01 刘总要求）──
  const containerRef = useRef<HTMLDivElement | null>(null);
  const [leftWidth, setLeftWidth] = useState<number>(() => {
    try { return Math.min(420, Math.max(180, Number(window.localStorage.getItem('metis:submission-left-width')) || 248)); } catch { return 248; }
  });
  const [rightWidth, setRightWidth] = useState<number>(() => {
    try { return Math.min(560, Math.max(300, Number(window.localStorage.getItem('metis:submission-right-width')) || 392)); } catch { return 392; }
  });
  const [leftCollapsed, setLeftCollapsed] = useState<boolean>(() => {
    try { return window.localStorage.getItem('metis:submission-left-collapsed') === '1'; } catch { return false; }
  });
  const applyLeftDrag = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setLeftWidth(Math.min(420, Math.max(180, Math.round(clientX - rect.left))));
  }, []);
  const applyRightDrag = useCallback((clientX: number) => {
    const rect = containerRef.current?.getBoundingClientRect();
    if (!rect) return;
    setRightWidth(Math.min(560, Math.max(300, Math.round(rect.right - clientX))));
  }, []);
  const persistWidths = useCallback(() => {
    try {
      window.localStorage.setItem('metis:submission-left-width', String(leftWidth));
      window.localStorage.setItem('metis:submission-right-width', String(rightWidth));
    } catch { /* best-effort */ }
  }, [leftWidth, rightWidth]);

  // ── 左栏：项目成果 ──
  useEffect(() => {
    let alive = true;
    if (!projectId || !window.metis?.listOutcomes) return undefined;
    void window.metis.listOutcomes({ projectId, query: '' }).then((rows) => {
      if (!alive || !Array.isArray(rows)) return;
      const mapped = rows.map((row: { id: string; title: string; currentVersion: number }) => ({ id: row.id, title: row.title, currentVersion: row.currentVersion }));
      setOutcomes(mapped);
      setActiveOutcomeId((current) => current ?? mapped[0]?.id ?? null);
    }).catch(() => undefined);
    return () => { alive = false; };
  }, [projectId]);

  // ── 中栏：共享浏览器生命周期（进入显示、离开隐藏、bounds 跟随宿主） ──
  const syncBounds = useCallback(() => {
    const host = hostRef.current;
    const metis = window.metis;
    if (!host || !metis?.browserSetBounds || !metis?.browserShow) return;
    const rect = host.getBoundingClientRect();
    if (rect.width < 40 || rect.height < 40) return;
    // 向内收缩 6px：WebContentsView 是原生层、永远盖在 DOM 之上，不收缩会把
    // 相邻的 SplitHandle 挡住（鼠标落在视图上，拖柄点不到）。
    const insetBounds = { x: Math.round(rect.left + 6), y: Math.round(rect.top), width: Math.round(rect.width - 12), height: Math.round(rect.height) };
    void metis.browserSetBounds(insetBounds);
    if (!visibleRef.current) {
      visibleRef.current = true;
      void metis.browserShow(insetBounds);
    }
  }, []);

  useEffect(() => {
    syncBounds();
    const observer = new ResizeObserver(() => syncBounds());
    if (hostRef.current) observer.observe(hostRef.current);
    window.addEventListener('resize', syncBounds);
    // 全局弹层/模态打开时 App 统一 browserHide，关闭后派发恢复事件；
    // 必须重置可见标记再 syncBounds，否则 visibleRef 停在 true，视图永不恢复。
    const restore = () => { visibleRef.current = false; syncBounds(); };
    window.addEventListener('metis:restore-embedded-views', restore);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', syncBounds);
      window.removeEventListener('metis:restore-embedded-views', restore);
    };
  }, [syncBounds]);

  useEffect(() => {
    // 首次进入：把第一个 tab 的默认页打开（持久分区保留登录态，重复 navigate 幂等）。
    // 任务2：显式声明导航归属当前项目，供参谋注入浏览器上下文前校验。
    const metis = window.metis;
    if (!metis?.browserNavigate) return;
    void metis.browserNavigate(DEFAULT_TABS[0]!.url, projectId ?? null).catch(() => undefined);
    return () => {
      visibleRef.current = false;
      void window.metis?.browserHide?.().catch(() => undefined);
    };
  }, []);

  // 用户在页面里点击导航后，把真实 URL/标题同步回当前 tab。
  useEffect(() => {
    const metis = window.metis;
    if (!metis?.browserState) return undefined;
    const timer = window.setInterval(() => {
      void metis.browserState?.().then((result) => {
        if (!result.ok || !result.state) return;
        setBrowserState({ url: result.state.url, title: result.state.title, canGoBack: result.state.canGoBack, canGoForward: result.state.canGoForward });
        setTabs((current) => current.map((tab) => (tab.id === activeTabId ? { ...tab, url: result.state!.url, title: result.state!.title || tab.title } : tab)));
      }).catch(() => undefined);
    }, 2_500);
    return () => window.clearInterval(timer);
  }, [activeTabId]);

  const openInBrowser = useCallback(async (url: string) => {
    const metis = window.metis;
    if (!metis?.browserNavigate || !/^https?:\/\//iu.test(url)) return;
    await metis.browserNavigate(url, projectId ?? null).catch(() => undefined);
    setTabs((current) => current.map((tab) => (tab.id === activeTabId ? { ...tab, url, title: tab.title } : tab)));
  }, [activeTabId]);

  const navigateTab = useCallback(async (kind: 'back' | 'forward' | 'reload') => {
    const metis = window.metis;
    if (!metis) return;
    if (kind === 'back') await metis.browserBack?.().catch(() => undefined);
    else if (kind === 'forward') await metis.browserForward?.().catch(() => undefined);
    else await metis.browserReload?.().catch(() => undefined);
  }, []);

  // ── 右栏：投稿参谋对话 ──
  const send = useCallback(async (text: string) => {
    const instruction = text.trim();
    const metis = window.metis;
    if (!instruction || sending || !metis?.submissionAssistantChat) return;
    if (!projectId || !activeOutcomeId) {
      setMessages((current) => [...current, { id: `sys-${Date.now()}`, role: 'assistant', content: zh ? '请先在左侧选择一个要投稿的成果。' : 'Select an outcome first.' }]);
      return;
    }
    setDraft('');
    setSending(true);
    setMessages((current) => [...current, { id: `user-${Date.now()}`, role: 'user', content: instruction }]);
    try {
      let thinkingLevel: string | undefined;
      try { thinkingLevel = localStorage.getItem('metis:thinking-level') ?? undefined; } catch { /* 隐私模式下不传 */ }
      // 任务6:回传最近 12 条对话作为参谋记忆(连续会话,不再每轮失忆)。
      const history = messages.slice(-12)
        .filter((message) => message.role === 'user' || message.role === 'assistant')
        .map((message) => ({ role: message.role as 'user' | 'assistant', content: message.content }));
      const result = await metis.submissionAssistantChat({
        projectId, outcomeId: activeOutcomeId, instruction,
        ...(thinkingLevel ? { thinkingLevel } : {}),
        intent: Object.keys(intent).length > 0 ? intent : undefined,
        shortlist: shortlist.length > 0 ? shortlist : undefined,
        history: history.length > 0 ? history : undefined,
      });
      setMessages((current) => [...current, { id: `ai-${Date.now()}`, role: 'assistant', content: result && result.ok && result.answer ? result.answer : (result?.error ?? '本轮参谋未完成，请重试。') }]);
    } catch {
      setMessages((current) => [...current, { id: `ai-${Date.now()}`, role: 'assistant', content: '参谋请求没有完成；浏览器与成果均未被改动。' }]);
    } finally {
      setSending(false);
    }
  }, [activeOutcomeId, intent, projectId, sending, shortlist, zh]);

  const addToShortlist = useCallback((name: string, source?: string) => {
    setShortlist((current) => {
      if (current.some((item) => item.name === name)) return current;
      void window.metis?.submissionShortlistAdd?.({ projectId: projectId ?? '', name, source });
      return [...current, { name, source }];
    });
  }, [projectId]);

  const createSubmissionCase = useCallback(async (card: SubmissionCardData) => {
    const metis = window.metis;
    if (!metis?.createSubmissionCase || !projectId || !activeOutcomeId) return;
    if (creatingCase) return; // 任务4：防双击——同一次确认只创建一条投稿记录。
    const outcome = activeOutcome;
    setCreatingCase(true);
    try {
      const result = await metis.createSubmissionCase({
        projectId,
        title: `投稿 ${card.name}`,
        sourceOutcomeId: activeOutcomeId,
        sourceOutcomeVersion: outcome?.currentVersion ?? 1,
        targetJournalName: card.name,
        articleType: null,
        seriesId: null,
        notes: card.note ?? '',
        targetingCriteria: null,
        initialStatus: 'JOURNAL_SELECTED',
      });
      const created = result && 'submissionCase' in result ? result.submissionCase : null;
      setMessages((current) => [...current, {
        id: `ai-${Date.now()}`,
        role: 'assistant',
        content: created
          ? `已创建正式投稿记录「投稿 ${card.name}」（${created.status}）。接下来我可以在浏览器里帮你核对投稿要求、检查成果差距；在投稿系统里提交这类不可逆操作前，我都会先请你确认。`
          : '投稿记录创建未完成（可能已有同刊进行中的投稿），未产生重复记录。',
      }]);
      if (created) addToShortlist(card.name, '目标期刊');
    } catch {
      setMessages((current) => [...current, { id: `ai-${Date.now()}`, role: 'assistant', content: '投稿记录创建请求未完成，未产生记录；请重试。' }]);
    } finally {
      setCreatingCase(false);
    }
  }, [activeOutcome, activeOutcomeId, addToShortlist, creatingCase, projectId]);

  // ── 围栏块渲染（对话内的原生交互组件） ──
  const codeComponent = useMemo<Components['code']>(() => function SubmissionChatCode({ className, children, ...props }) {
    const match = /language-([\w-]+)/.exec(className || '');
    const code = String(children).replace(/\n$/, '');
    if (match?.[1] === 'metis-choice-group') {
      const group = parseFenceJson<ChoiceGroupData>(code);
      if (group?.question && Array.isArray(group.options)) {
        const chosen = (group.key && Array.isArray(intent[group.key]) ? intent[group.key] as string[] : []) ;
        return (
          <div className="submission-chat__choices" role="group" aria-label={group.question}>
            <strong>{group.question}</strong>
            <div className="submission-chat__choice-options">
              {group.options.map((option) => {
                const selected = group.multi ? chosen.includes(option) : chosen[0] === option;
                return (
                  <button
                    key={option}
                    type="button"
                    className={selected ? 'active' : ''}
                    onClick={() => {
                      if (!group.key) return;
                      setIntent((current) => {
                        const previous = Array.isArray(current[group.key]) ? current[group.key] as string[] : [];
                        const next = group.multi
                          ? (previous.includes(option) ? previous.filter((item) => item !== option) : [...previous, option])
                          : [option];
                        return { ...current, [group.key]: next };
                      });
                    }}
                  >
                    {option}
                  </button>
                );
              })}
            </div>
            <button
              type="button"
              className="submission-chat__choice-continue"
              onClick={() => {
                const answers = Array.isArray(intent[group.key]) ? (intent[group.key] as string[]).join('、') : '';
                if (answers) void send(`${group.question}：${answers}。请继续。`);
              }}
              disabled={!group.key || !Array.isArray(intent[group.key]) || (intent[group.key] as string[] | undefined)?.length === 0}
            >
              {zh ? '继续' : 'Continue'}
            </button>
          </div>
        );
      }
    }
    if (match?.[1] === 'metis-journal-card') {
      const card = parseFenceJson<JournalCardData>(code);
      if (card?.name) {
        return (
          <div className="submission-chat__journal-card">
            <header>
              <strong>{card.name}</strong>
              {(card.tags ?? []).map((tag) => <span key={tag} className="submission-chat__journal-tag">{tag}</span>)}
            </header>
            {card.verdict && <p className="submission-chat__journal-verdict">推荐程度：{card.verdict}</p>}
            {(card.fit ?? []).length > 0 && <ul>{card.fit!.map((item) => <li key={item}>✓ {item}</li>)}</ul>}
            {(card.risks ?? []).length > 0 && <ul>{card.risks!.map((item) => <li key={item}>⚠ {item}</li>)}</ul>}
            <footer>
              {card.url && <button type="button" onClick={() => void openInBrowser(card.url!)}><ExternalLink size={12} />在浏览器打开</button>}
              <button type="button" onClick={() => addToShortlist(card.name, (card.tags ?? []).join('/'))}><Star size={12} />收藏</button>
            </footer>
          </div>
        );
      }
    }
    if (match?.[1] === 'metis-submission-card') {
      const card = parseFenceJson<SubmissionCardData>(code);
      if (card?.name) {
        return (
          <div className="submission-chat__submission-card">
            <strong>设「{card.name}」为目标期刊？</strong>
            {card.note && <p>{card.note}</p>}
            <footer>
              <button type="button" className="primary" disabled={creatingCase} onClick={() => void createSubmissionCase(card)}>{creatingCase ? '创建中…' : '确认创建投稿记录'}</button>
            </footer>
          </div>
        );
      }
    }
    if (match?.[1]) return <pre className="submission-chat__code"><code>{code}</code></pre>;
    return <code className="inline-code" {...props}>{children}</code>;
  }, [addToShortlist, createSubmissionCase, intent, openInBrowser, send, zh]);

  const activeTab = tabs.find((tab) => tab.id === activeTabId) ?? tabs[0]!;

  return (
    <div className="submission-workspace" role="region" aria-label="投稿工作区" ref={containerRef}>
      {leftCollapsed && (
        <button
          type="button"
          className="submission-workspace__left-expand"
          onClick={() => { setLeftCollapsed(false); try { window.localStorage.setItem('metis:submission-left-collapsed', '0'); } catch { /* best-effort */ } setTimeout(syncBounds, 30); }}
          title={zh ? '展开成果栏' : 'Expand outcomes pane'}
          aria-label={zh ? '展开成果栏' : 'Expand outcomes pane'}
        >
          <PanelLeftOpen size={15} />
        </button>
      )}
      {!leftCollapsed && (
      <aside className="submission-workspace__left" style={{ width: leftWidth, flex: `0 0 ${leftWidth}px` }} aria-label={zh ? '项目成果与候选' : 'Outcomes and shortlist'}>
        <div className="submission-workspace__left-head">
          <h3>{zh ? '项目与候选' : 'Project'}</h3>
          <button
            type="button"
            onClick={() => { setLeftCollapsed(true); try { window.localStorage.setItem('metis:submission-left-collapsed', '1'); } catch { /* best-effort */ } setTimeout(syncBounds, 30); }}
            title={zh ? '收起成果栏' : 'Collapse outcomes pane'}
            aria-label={zh ? '收起成果栏' : 'Collapse outcomes pane'}
          >
            <PanelLeftClose size={14} />
          </button>
        </div>
        <section aria-label={zh ? '可投稿成果' : 'Outcomes'}>
          <h3>{zh ? '可投稿成果' : 'Outcomes'}</h3>
          {outcomesStale && <StaleDataNotice onRetry={() => void loadOutcomesList()} retrying={outcomesRetrying} />}
          {outcomesState === 'error' && (
            <InlineError
              compact
              title={zh ? '成果列表加载失败。' : 'Could not load outcomes.'}
              hint={zh ? '成果数据没有丢失，只是暂时读不到。' : 'Data is safe; retry when ready.'}
              onRetry={() => void loadOutcomesList()}
              retrying={outcomesRetrying}
            />
          )}
          {outcomesState === 'loading' && outcomes.length === 0 && <QuietLoading compact label={zh ? '正在加载成果…' : 'Loading outcomes…'} />}
          {outcomesState === 'ready' && outcomes.length === 0 && (
            <EmptyState
              compact
              title={projectId ? (zh ? '当前项目还没有成果' : 'No outcomes yet') : (zh ? '成果属于科研项目' : 'Outcomes belong to a project')}
              description={projectId
                ? (zh ? '投稿从成果出发：先到成果工作台创建或导入论文 / 报告。' : 'Create or import a paper in the Outcomes workspace first.')
                : (zh ? '请先选择一个科研项目，再管理论文、PPT、报告与正式交付物。' : 'Select a project first, then manage papers and reports.')}
              action={projectId ? (
                <button type="button" onClick={() => navigate({ kind: 'standalone', page: 'outcomes' })}>
                  {zh ? '去成果工作台' : 'Open Outcomes'}
                </button>
              ) : undefined}
            />
          )}
          <ul>
            {outcomes.map((outcome) => (
              <li key={outcome.id}>
                <button
                  type="button"
                  className={outcome.id === activeOutcomeId ? 'active' : ''}
                  onClick={() => setActiveOutcomeId(outcome.id)}
                  title={zh ? '选中后，投稿参谋将以该成果为上下文' : 'Set as the artifact context'}
                >
                  {outcome.title}
                  <small>v{outcome.currentVersion}</small>
                </button>
              </li>
            ))}
          </ul>
        </section>
        <section aria-label={zh ? '候选期刊' : 'Shortlist'}>
          <h3>{zh ? '候选期刊' : 'Shortlist'}</h3>
          {shortlistState === 'error' && (
            <InlineError
              compact
              title={zh ? '候选名单加载失败。' : 'Could not load the shortlist.'}
              onRetry={() => {
                setShortlistState('loading');
                void window.metis?.submissionShortlistList?.(projectId ?? '').then((rows) => {
                  if (Array.isArray(rows)) {
                    setShortlist(rows.map((row) => ({ name: String(row.name), source: String(row.source || '') })));
                    setShortlistState('ready');
                  }
                }).catch(() => setShortlistState('error'));
              }}
            />
          )}
          {shortlistState !== 'error' && shortlist.length === 0 && <p className="submission-workspace__muted">{zh ? '收藏或确定候选后会出现在这里。' : 'Star journals to collect them.'}</p>}
          <ul>
            {shortlist.map((item) => (
              <li key={item.name} style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <Star size={12} /> {item.name}{item.source ? <small>{item.source}</small> : null}
                <button
                  type="button"
                  onClick={() => {
                    setShortlist((current) => current.filter((entry) => entry.name !== item.name));
                    void window.metis?.submissionShortlistRemove?.({ projectId: projectId ?? '', name: item.name });
                  }}
                  aria-label={`移除 ${item.name}`}
                  title="从短名单移除"
                  style={{ marginLeft: 'auto', border: 0, background: 'transparent', color: 'var(--text-muted)', cursor: 'pointer' }}
                >
                  <X size={12} />
                </button>
              </li>
            ))}
          </ul>
        </section>
      </aside>
      )}

      <SplitHandle
        label={zh ? '拖动调整成果栏宽度' : 'Resize outcomes pane'}
        onDragStart={() => { void window.metis?.browserHide?.().catch(() => undefined); visibleRef.current = false; }}
        onDrag={applyLeftDrag}
        onDragEnd={() => { persistWidths(); syncBounds(); }}
        onKeyDelta={(delta) => setLeftWidth((current) => Math.min(420, Math.max(180, current + delta)))}
      />

      <section className="submission-workspace__browser" aria-label={zh ? '共享浏览器' : 'Shared browser'}>
        <div className="submission-workspace__tabs" role="tablist">
          {tabs.map((tab) => (
            <button
              key={tab.id}
              type="button"
              role="tab"
              aria-selected={tab.id === activeTabId}
              className={tab.id === activeTabId ? 'active' : ''}
              onClick={() => {
                setActiveTabId(tab.id);
                if (tab.url && tab.url !== browserState?.url) void openInBrowser(tab.url);
              }}
            >
              {tab.title}
              {tabs.length > 1 && (
                <span
      role="button"
      tabIndex={0}
      aria-label={zh ? '关闭标签页' : 'Close tab'}
      className="submission-workspace__tab-close"
      onClick={(event) => {
        event.stopPropagation();
        setTabs((current) => {
          const next = current.filter((item) => item.id !== tab.id);
          if (tab.id === activeTabId && next[0]) void openInBrowser(next[0].url);
          return next.length > 0 ? next : current;
        });
        setActiveTabId((current) => (current === tab.id ? (tabs.find((item) => item.id !== tab.id)?.id ?? current) : current));
      }}
      onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') event.stopPropagation(); }}
    >
                  <X size={11} />
                </span>
              )}
            </button>
          ))}
          <button
            type="button"
            title={zh ? '新标签页' : 'New tab'}
            onClick={() => {
              const id = `tab-${Date.now()}`;
              setTabs((current) => [...current, { id, title: '新标签页', url: 'https://www.bing.com' }]);
              setActiveTabId(id);
              void openInBrowser('https://www.bing.com');
            }}
          >
            <Plus size={13} />
          </button>
        </div>
        <div className="submission-workspace__addressbar">
          <button type="button" disabled={!browserState?.canGoBack} onClick={() => void navigateTab('back')} aria-label="后退"><ArrowLeft size={14} /></button>
          <button type="button" disabled={!browserState?.canGoForward} onClick={() => void navigateTab('forward')} aria-label="前进"><ArrowRight size={14} /></button>
          <button type="button" onClick={() => void navigateTab('reload')} aria-label="刷新"><RotateCw size={14} /></button>
          <input
            value={addressDraft || browserState?.url || activeTab.url}
            onChange={(event) => setAddressDraft(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                const target = addressDraft.trim();
                if (target) void openInBrowser(/^https?:\/\//iu.test(target) ? target : `https://${target}`);
                setAddressDraft('');
              }
            }}
            aria-label="地址栏"
          />
          <button type="button" title={zh ? '在系统浏览器打开' : 'Open externally'} onClick={() => { const url = browserState?.url; if (url) void window.metis?.openExternal?.(url); }}><ExternalLink size={14} /></button>
        </div>
        <div ref={hostRef} className="submission-workspace__browser-host" data-testid="submission-browser-host" />
      </section>

      <SplitHandle
        label={zh ? '拖动调整参谋栏宽度' : 'Resize copilot pane'}
        onDragStart={() => { void window.metis?.browserHide?.().catch(() => undefined); visibleRef.current = false; }}
        onDrag={applyRightDrag}
        onDragEnd={() => { persistWidths(); syncBounds(); }}
        onKeyDelta={(delta) => setRightWidth((current) => Math.min(560, Math.max(300, current - delta)))}
      />

      <aside className="submission-workspace__chat" style={{ width: rightWidth, flex: `0 0 ${rightWidth}px` }} aria-label={zh ? '投稿参谋' : 'Submission copilot'}>
        <header>
          <span className="submission-workspace__chat-mark"><Sparkles size={14} /></span>
          <div>
            <h2>{zh ? '投稿参谋' : 'Submission Copilot'}</h2>
            <p>{zh ? '你们共享同一个浏览器；AI 始终知道当前成果' : 'Shared browser · artifact-aware'}</p>
          </div>
        </header>
        <div className="submission-workspace__messages">
          {messages.length === 0 && (
            <div className="submission-workspace__chat-empty">
              <p>{activeOutcome
                ? `当前成果：《${activeOutcome.title}》。告诉我你想投什么类型的期刊，或直接在中间浏览器里找，看到合适的问我“这个怎么样”。`
                : '先在左侧选择一个成果。'}
              </p>
              <div>
                {['帮我找适合这篇文章的期刊', 'CSSCI 就行，最好命中率高一点'].map((suggestion) => (
                  <button key={suggestion} type="button" onClick={() => void send(suggestion)} disabled={!activeOutcomeId || sending}>{suggestion}</button>
                ))}
              </div>
            </div>
          )}
          {messages.map((message) => (
            message.role === 'user'
              ? <UserTurn key={message.id} message={{ id: message.id, role: 'user', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
              : <AssistantTurn key={message.id} message={{ id: message.id, role: 'assistant', createdAt: 0, parts: [{ type: 'text', text: message.content }] }} />
          ))}
          {sending && <div className="submission-chat__thinking" role="status">{zh ? '参谋正在调查（浏览器可能会自动翻页）…' : 'Investigating…'}</div>}
        </div>
        <footer className="submission-workspace__composer">
          <div className="chat-input-maincol">
            <div className="chat-input-topbar">
              <ModelThinkingSelector zh={zh} labeled disabled={sending} />
            </div>
            <div className="chat-input-row">
              <textarea
                ref={textareaRef}
                className="chat-textarea submission-chat-textarea"
                rows={1}
                value={draft}
                onChange={(event) => { setDraft(event.target.value); if (textareaRef.current) autoResizeTextarea(textareaRef.current, 6); }}
                onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey) { event.preventDefault(); void send(draft); } }}
                placeholder={zh ? '帮我找合适的期刊，或就当前页面提问…' : 'Ask anything…'}
                aria-label="投稿参谋输入框"
              />
              <button type="button" className="chat-send" onClick={() => void send(draft)} disabled={!draft.trim() || sending}>{zh ? '发送' : 'Send'}</button>
            </div>
          </div>
        </footer>
      </aside>
    </div>
  );
}
