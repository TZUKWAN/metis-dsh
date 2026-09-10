/**
 * ChatbotCollabPanel — Topic Workspace 内的 Chatbot 协作面板
 * （2026-09-05 刘总规格书：第三方 AI 能力迁入选题工作区）。
 *
 * 顶栏极简：一个 Dropdown 选择六家（ChatGPT/Claude/DeepSeek/Kimi/豆包/GLM
 * + 自定义站点），最后一项「管理 Chatbot…」打开管理抽屉（增删改站点）。
 * 双向 Context Bridge：
 *  - METIS→Chatbot「发送上下文」：宿主生成的 Context Package 写入剪贴板后
 *    经 collabPaste 原生粘贴进第三方 AI 页面；粘贴失败时内容仍在剪贴板，
 *    如实提示手动粘贴（clipboard fallback，绝不假装已发送）。
 *  - Chatbot→METIS「引用到 METIS」：只读捕获选区原文（失败 fallback 读剪贴板）
 *    → 确认卡（Human Confirmation）→ externalRefAdd 落库 + 宿主会话注入
 *    「外部参考·非证据」条目。确认前不写任何存储。
 * 嵌入视图复用主进程 CollabService（WebContentsView，登录态独立持久化）。
 */

import { useCallback, useEffect, useRef, useState } from 'react';

import {
  CHATBOT_LAST_AI_KEY,
  CHATBOT_SITES_STORAGE_KEY,
  DEFAULT_CHATBOT_SITES,
  loadChatbotSites,
  normalizeChatbotUrl,
  type ChatbotSite,
} from './chatbotSites';
import type { ExternalModelReference } from '../../engine/runtime/ExternalReferenceContract.js';
import './ChatbotCollabPanel.css';

const MANAGE_SENTINEL = '__manage__';

interface SiteDraft {
  id?: string;
  name: string;
  url: string;
}

export interface ChatbotCollabPanelProps {
  zh: boolean;
  /** 宿主生成 Context Package（Topic 会话上下文）；返回 null 表示无可发上下文。 */
  buildContextPackage: () => string | null;
  projectId: string | null;
  sessionId: string | null;
  /** Chatbot 面板占双栏宽度比例（0.40–0.45），由宿主持有并持久化。 */
  splitRatio: number;
  onSplitRatioChange: (ratio: number) => void;
  /** 确认卡通过、引用落库成功后的宿主回调（注入 Topic 会话 externalRef part）。 */
  onReferenceConfirmed: (reference: ExternalModelReference, duplicate: boolean) => void;
  onClose: () => void;
}

export default function ChatbotCollabPanel({
  zh,
  buildContextPackage,
  projectId,
  sessionId,
  splitRatio,
  onReferenceConfirmed,
  onClose,
}: ChatbotCollabPanelProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const panelRef = useRef<HTMLElement>(null);
  const [sites, setSites] = useState<ChatbotSite[]>(() => {
    try { return loadChatbotSites(window.localStorage.getItem(CHATBOT_SITES_STORAGE_KEY)); } catch { return DEFAULT_CHATBOT_SITES; }
  });
  const [activeAiId, setActiveAiId] = useState<string>(() => {
    try {
      const saved = window.localStorage.getItem(CHATBOT_LAST_AI_KEY);
      const list = loadChatbotSites(window.localStorage.getItem(CHATBOT_SITES_STORAGE_KEY));
      return list.some((site) => site.id === saved) ? (saved as string) : (list[0]?.id ?? '');
    } catch {
      return DEFAULT_CHATBOT_SITES[0]!.id;
    }
  });
  const [manageOpen, setManageOpen] = useState(false);
  const [editing, setEditing] = useState<SiteDraft | null>(null);
  const [editError, setEditError] = useState('');
  const [bridgeNotice, setBridgeNotice] = useState<{ tone: 'ok' | 'error'; text: string } | null>(null);
  const [pendingCapture, setPendingCapture] = useState<{ model: string; url: string; text: string } | null>(null);
  const [awaitClipboardFallback, setAwaitClipboardFallback] = useState(false);
  const [busy, setBusy] = useState(false);

  const persistSites = useCallback((next: ChatbotSite[]) => {
    setSites(next);
    try { window.localStorage.setItem(CHATBOT_SITES_STORAGE_KEY, JSON.stringify(next)); } catch { /* best-effort */ }
  }, []);

  const activeSite = sites.find((site) => site.id === activeAiId) ?? sites[0] ?? null;

  // ── 嵌入视图边界同步（复用主进程 CollabService） ──────────────
  useEffect(() => {
    const host = hostRef.current;
    const metis = window.metis;
    if (!host || !metis?.collabShow || !activeSite) return;
    const report = () => {
      const rect = host.getBoundingClientRect();
      if (rect.width < 4 || rect.height < 4) return;
      void metis.collabSetBounds?.({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    };
    report();
    const rect = host.getBoundingClientRect();
    void metis.collabShow({ x: rect.left, y: rect.top, width: rect.width, height: rect.height });
    const observer = new ResizeObserver(report);
    observer.observe(host);
    window.addEventListener('resize', report);
    // 全局弹层关闭后恢复嵌入视图（App 在弹层打开时统一隐藏）。
    const restore = () => {
      const next = host.getBoundingClientRect();
      if (next.width >= 4 && next.height >= 4) {
        void metis.collabShow?.({ x: next.left, y: next.top, width: next.width, height: next.height });
      }
    };
    window.addEventListener('metis:restore-embedded-views', restore);
    return () => {
      observer.disconnect();
      window.removeEventListener('resize', report);
      window.removeEventListener('metis:restore-embedded-views', restore);
      // 卸载时必须隐藏原生嵌入视图：否则离开选题页后 Chatbot 仍会盖在
      // 成果/投稿等页面上（原生 WebContentsView 永远在 DOM 之上）。
      void window.metis?.collabHide?.();
    };
  }, [activeSite]);

  useEffect(() => {
    if (!activeSite) return;
    void window.metis?.collabNavigate?.(activeSite.url);
    try { window.localStorage.setItem(CHATBOT_LAST_AI_KEY, activeSite.id); } catch { /* best-effort */ }
  }, [activeSite]);

  // ── METIS → Chatbot（发送上下文） ────────────────────────────
  const sendContext = useCallback(async () => {
    setBridgeNotice(null);
    const pkg = buildContextPackage();
    if (!pkg) {
      setBridgeNotice({ tone: 'error', text: zh ? '当前没有可发送的选题上下文（先创建或进入一个选题会话）。' : 'No topic context available yet.' });
      return;
    }
    setBusy(true);
    try {
      const write = await window.metis?.clipboardWriteText?.(pkg);
      if (!write?.ok) {
        setBridgeNotice({ tone: 'error', text: zh ? '上下文写入剪贴板失败，未发送。' : 'Failed to copy context to clipboard.' });
        return;
      }
      const paste = await window.metis?.collabPaste?.();
      if (paste?.ok) {
        setBridgeNotice({ tone: 'ok', text: zh ? '上下文已粘贴到 Chatbot 输入框，请检查后回车发送。' : 'Context pasted into the Chatbot input.' });
      } else {
        // clipboard fallback：内容已在剪贴板，如实告知手动粘贴。
        setBridgeNotice({
          tone: 'error',
          text: zh
            ? `自动粘贴未成功（${paste?.error ?? '未知原因'}）。上下文已复制到剪贴板，请到 Chatbot 输入框手动粘贴。`
            : `Auto-paste failed (${paste?.error ?? 'unknown'}). Context is on your clipboard—paste manually.`,
        });
      }
    } finally {
      setBusy(false);
    }
  }, [buildContextPackage, zh]);

  // ── Chatbot → METIS（引用到 METIS，确认后才入库） ────────────
  const captureSelection = useCallback(async () => {
    setBridgeNotice(null);
    setBusy(true);
    try {
      let text = '';
      let sourceError = '';
      if (awaitClipboardFallback) {
        const clip = await window.metis?.clipboardReadText?.();
        text = clip?.ok ? (clip.text ?? '') : '';
        if (!text.trim()) {
          setBridgeNotice({ tone: 'error', text: zh ? '剪贴板为空。请先在 Chatbot 页选中文本并复制，再点「引用到 METIS」。' : 'Clipboard is empty.' });
          return;
        }
      } else {
        const capture = await window.metis?.collabCaptureSelection?.();
        if (capture?.ok && capture.text?.trim()) {
          text = capture.text;
        } else {
          sourceError = capture?.error ?? 'empty_selection';
          setAwaitClipboardFallback(true);
          setBridgeNotice({
            tone: 'error',
            text: zh
              ? `无法直接读取选区（${sourceError}）。请改用：在 Chatbot 页复制该文本后，再点一次「引用到 METIS」，将从剪贴板读取。`
              : `Selection capture failed (${sourceError}). Copy the text, then click again to read from clipboard.`,
          });
          return;
        }
      }
      const state = await window.metis?.collabGetState?.();
      const url = state?.state?.url || activeSite?.url || '';
      const model = activeSite?.name || (zh ? '外部模型' : 'External model');
      setPendingCapture({ model, url, text: text.trim().slice(0, 20_000) });
      setAwaitClipboardFallback(false);
    } finally {
      setBusy(false);
    }
  }, [activeSite, awaitClipboardFallback, zh]);

  const confirmReference = useCallback(async () => {
    if (!pendingCapture) return;
    setBusy(true);
    try {
      const result = await window.metis?.externalRefAdd?.({
        v: 1,
        model: pendingCapture.model,
        url: pendingCapture.url,
        quotedText: pendingCapture.text,
        capturedAt: Date.now(),
        projectId: projectId,
        sessionId: sessionId,
      });
      if (!result?.ok || !result.reference) {
        setBridgeNotice({ tone: 'error', text: `${zh ? '引用入库失败' : 'Failed to store reference'}: ${(result?.issues ?? []).join('; ') || 'unknown'}` });
        return;
      }
      setPendingCapture(null);
      setBridgeNotice({
        tone: 'ok',
        text: zh
          ? (result.duplicate ? '该引用已存在（按内容指纹去重），未重复入库。' : '已作为「外部参考·非证据」加入选题上下文。外部模型内容永不会被当作证据。')
          : (result.duplicate ? 'Reference already stored (deduplicated).' : 'Stored as an external (non-evidence) reference.'),
      });
      onReferenceConfirmed(result.reference, Boolean(result.duplicate));
    } finally {
      setBusy(false);
    }
  }, [pendingCapture, projectId, sessionId, zh, onReferenceConfirmed]);

  // ── 站点管理 ─────────────────────────────────────────────────
  const handleDeleteSite = useCallback((id: string) => {
    persistSites(sites.filter((site) => site.id !== id));
    if (editing?.id === id) setEditing(null);
  }, [sites, persistSites, editing]);

  const saveEditing = useCallback(() => {
    if (!editing) return;
    const name = editing.name.trim().slice(0, 16);
    const url = normalizeChatbotUrl(editing.url.trim());
    if (!name || !url) {
      setEditError(zh ? '名称与合法 URL 均必填。' : 'Name and a valid URL are required.');
      return;
    }
    if (editing.id) {
      persistSites(sites.map((site) => (site.id === editing.id ? { ...site, name, url } : site)));
    } else {
      const id = `custom-${Date.now().toString(36)}`;
      persistSites([...sites, { id, name, url }]);
      setActiveAiId(id);
    }
    setEditing(null);
    setEditError('');
  }, [editing, sites, persistSites, zh]);

  const resetDefaults = useCallback(() => {
    persistSites(DEFAULT_CHATBOT_SITES);
    setEditing(null);
  }, [persistSites]);

  const onDropdownChange = useCallback((value: string) => {
    if (value === MANAGE_SENTINEL) {
      setManageOpen(true);
      setEditing(null);
      return;
    }
    setActiveAiId(value);
  }, []);

  return (
    <section
      ref={panelRef}
      className="chatbot-panel"
      data-testid="chatbot-panel"
      aria-label={zh ? 'Chatbot 协作面板' : 'Chatbot collaboration panel'}
      style={{ flex: `0 0 ${(splitRatio * 100).toFixed(2)}%` }}
    >
      <header className="chatbot-panel__header">
        <select
          className="chatbot-panel__select"
          data-testid="chatbot-select"
          aria-label={zh ? '选择 Chatbot' : 'Choose Chatbot'}
          value={activeSite?.id ?? ''}
          onChange={(event) => onDropdownChange(event.target.value)}
        >
          {sites.map((site) => (
            <option key={site.id} value={site.id}>{site.name}</option>
          ))}
          <option value={MANAGE_SENTINEL}>{zh ? '管理 Chatbot…' : 'Manage Chatbots…'}</option>
        </select>
        <button
          type="button"
          className="chatbot-panel__btn"
          data-testid="chatbot-send-context"
          disabled={busy}
          title={zh ? '把当前选题上下文（结构化 Markdown）粘贴到 Chatbot 输入框' : 'Paste topic context into the Chatbot input'}
          onClick={() => void sendContext()}
        >
          {zh ? '发送上下文' : 'Send context'}
        </button>
        <button
          type="button"
          className="chatbot-panel__btn"
          data-testid="chatbot-cite-selection"
          disabled={busy}
          title={zh ? '把 Chatbot 页选中/复制的文本作为外部参考引用进 METIS（需确认）' : 'Capture selected text as an external reference (confirmation required)'}
          onClick={() => void captureSelection()}
        >
          {zh ? '引用到 METIS' : 'Cite to METIS'}
        </button>
        <button
          type="button"
          className="chatbot-panel__btn chatbot-panel__btn--close"
          data-testid="chatbot-close"
          aria-label={zh ? '关闭 Chatbot 面板' : 'Close Chatbot panel'}
          title={zh ? '关闭 Chatbot' : 'Close Chatbot'}
          onClick={() => {
            void window.metis?.collabHide?.();
            onClose();
          }}
        >
          ×
        </button>
      </header>

      {bridgeNotice && (
        <p className={bridgeNotice.tone === 'ok' ? 'chatbot-panel__notice chatbot-panel__notice--ok' : 'chatbot-panel__notice chatbot-panel__notice--error'} data-testid="chatbot-bridge-notice" role="status">
          {bridgeNotice.text}
        </p>
      )}

      {pendingCapture && (
        <div className="chatbot-panel__confirm" data-testid="chatbot-confirm-card" role="dialog" aria-label={zh ? '确认引用外部模型内容' : 'Confirm external model reference'}>
          <p className="chatbot-panel__confirm-title">
            {zh ? '确认把以下内容引用进 METIS？' : 'Store this as an external reference?'}
          </p>
          <p className="chatbot-panel__confirm-meta">
            {pendingCapture.model} · {pendingCapture.url} · {new Date().toLocaleString()}
          </p>
          <pre className="chatbot-panel__confirm-quote" data-testid="chatbot-confirm-quote">{pendingCapture.text.slice(0, 2000)}</pre>
          <p className="chatbot-panel__confirm-warning">
            {zh ? '外部模型内容永不是证据：只作为「外部参考」进入选题上下文。' : 'External model output is never evidence—stored as external reference only.'}
          </p>
          <div className="chatbot-panel__confirm-actions">
            <button type="button" className="chatbot-panel__btn chatbot-panel__btn--primary" data-testid="chatbot-confirm-accept" disabled={busy} onClick={() => void confirmReference()}>
              {zh ? '确认引用' : 'Confirm'}
            </button>
            <button type="button" className="chatbot-panel__btn" data-testid="chatbot-confirm-cancel" onClick={() => setPendingCapture(null)}>
              {zh ? '取消' : 'Cancel'}
            </button>
          </div>
        </div>
      )}

      {manageOpen && (
        <div className="chatbot-panel__manage" data-testid="chatbot-manage-drawer">
          <div className="chatbot-panel__manage-head">
            <strong>{zh ? '管理 Chatbot 站点' : 'Manage Chatbot sites'}</strong>
            <span className="chatbot-panel__manage-actions">
              <button type="button" className="chatbot-panel__btn" data-testid="chatbot-reset-sites" onClick={resetDefaults}>
                {zh ? '恢复默认' : 'Reset defaults'}
              </button>
              <button type="button" className="chatbot-panel__btn" data-testid="chatbot-add" onClick={() => setEditing({ name: '', url: '' })}>
                {zh ? '添加' : 'Add'}
              </button>
              <button type="button" className="chatbot-panel__btn" onClick={() => { setManageOpen(false); setEditing(null); }}>
                {zh ? '完成' : 'Done'}
              </button>
            </span>
          </div>
          {editing && (
            <div className="chatbot-panel__site-form" data-testid="chatbot-site-form">
              <label>
                <span>{zh ? '名称' : 'Name'}</span>
                <input className="settings-input" value={editing.name} onChange={(event) => setEditing({ ...editing, name: event.target.value })} placeholder={zh ? '例如：豆包' : 'e.g. Doubao'} data-testid="chatbot-site-name-input" />
              </label>
              <label>
                <span>URL</span>
                <input className="settings-input" value={editing.url} onChange={(event) => setEditing({ ...editing, url: event.target.value })} placeholder="https://…" data-testid="chatbot-site-url-input" />
              </label>
              <div className="chatbot-panel__confirm-actions">
                <button type="button" className="chatbot-panel__btn chatbot-panel__btn--primary" onClick={saveEditing} data-testid="chatbot-site-save">{zh ? '保存' : 'Save'}</button>
                <button type="button" className="chatbot-panel__btn" onClick={() => { setEditing(null); setEditError(''); }}>{zh ? '取消' : 'Cancel'}</button>
              </div>
              {editError && <p className="chatbot-panel__notice chatbot-panel__notice--error" role="alert">{editError}</p>}
            </div>
          )}
          <ul className="chatbot-panel__site-list">
            {sites.map((site) => (
              <li key={site.id}>
                <span className="chatbot-panel__site-name">{site.name}</span>
                <span className="chatbot-panel__site-url">{site.url}</span>
                <button type="button" className="chatbot-panel__btn" data-testid={`chatbot-edit-${site.id}`} onClick={() => setEditing({ id: site.id, name: site.name, url: site.url })}>
                  {zh ? '编辑' : 'Edit'}
                </button>
                <button type="button" className="chatbot-panel__btn" aria-label={zh ? '删除站点' : 'Delete site'} data-testid={`chatbot-remove-${site.id}`} onClick={() => handleDeleteSite(site.id)}>
                  ×
                </button>
              </li>
            ))}
            {sites.length === 0 && <li className="chatbot-panel__site-empty">{zh ? '清单为空——添加或恢复默认。' : 'No sites—add one or reset defaults.'}</li>}
          </ul>
          <p className="chatbot-panel__hint">{zh ? '网页版登录态独立保存在 METIS 内部分区，不会与普通浏览互通。' : 'Logins persist in an isolated METIS partition.'}</p>
        </div>
      )}

      {activeSite ? (
        <div className="chatbot-panel__host" ref={hostRef} data-testid="chatbot-host" />
      ) : (
        <div className="chatbot-panel__empty">
          <p>{zh ? '没有可用站点——点「管理 Chatbot…」添加。' : 'No sites—add one via Manage.'}</p>
        </div>
      )}
    </section>
  );
}
