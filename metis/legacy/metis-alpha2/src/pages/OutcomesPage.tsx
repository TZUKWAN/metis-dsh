import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import {
  ArrowDown, ArrowLeft, ArrowRight, ArrowUp, Bot, Check, Copy, Download, FileText,
  FileSpreadsheet, GripVertical, History, Image as ImageIcon, LoaderCircle, Maximize2,
  Minus, Move, Pencil, Plus, Presentation, RotateCcw, Save, Send,
  SlidersHorizontal, Sparkles, Table2, Trash2, Type, Underline, Upload, X,
} from 'lucide-react';
import { useResearchWorkspaceStore } from '../research/researchWorkspaceStore';
import {
  OutcomeDetailSchema, decodePptTemplateDefinition, type OutcomeAssistantAppliedEdit, type OutcomeAssistantChatResult,
  type OutcomeAssistantSelection as OutcomeAssistantRequestSelection, type OutcomeCategory,
  type OutcomeDetail, type OutcomeDocument, type OutcomeKind, type OutcomeMedia,
  type OutcomeSource, type OutcomeSummary, type OutcomeTrashEntry, type OutcomeVersion, type PptDocument, type PptPage, type OutcomePptxWarning, type OutcomeWordDocxWarning,
  type PptGenerationApplied, type PptGenerationResult, type PptGenerationSkill, type PptTemplate, type WordDocument,
} from '../../engine/runtime/OutcomeRuntimeContract';
import './OutcomesPage.css';
import { autoResizeTextarea } from '../lib/textareaAutosize.js';
import ModelThinkingSelector from '../components/ModelThinkingSelector';
import { OutcomeWordFormattingPanel } from '../components/OutcomeWordFormattingPanel';
import { OfficeWordRibbon } from '../components/OfficeWordRibbon';
import { OfficePptRibbon } from '../components/OfficePptRibbon';
import SplitHandle from '../components/SplitHandle';
import { useTranslation } from '../i18n';
import { EmptyState, InlineError, QuietLoading, StaleDataNotice } from '../components/async/AsyncFeedback';

import { readStickyValue } from '../hooks/workspacePersistence';
import { navigate } from '../shell/navigation';

const OUTCOMES_TREE_WIDTH_KEY = 'metis-outcomes-tree-width';
const OUTCOMES_ASSISTANT_WIDTH_KEY = 'metis-outcomes-assistant-width';

function loadOutcomesWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function saveOutcomesWidth(key: string, value: number): void {
  try { window.localStorage.setItem(key, String(Math.round(value))); } catch { /* best-effort */ }
}

type AssistantSelection = { kind: 'word'; blockId: string; text: string; start?: number; end?: number; row?: number; column?: number; cross?: { endBlockId: string; endOffset: number } } | { kind: 'ppt'; pageId: string; elementId?: string } | undefined;
type ScopedMessage = { id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: OutcomeSource[]; createdAt: number };
type ConversationUnit = { id: string; title: string; messageCount: number; createdAt: number; updatedAt: number };
type AssistantApplied = OutcomeAssistantAppliedEdit;
type AssistantResult = OutcomeAssistantChatResult;
type OutcomeAssistantBridge = {
  chatOutcomeAssistant?: (request: { projectId: string; outcomeId: string; instruction: string; selection?: OutcomeAssistantRequestSelection }) => Promise<AssistantResult>;
  outcomesConversationUnits?: (request: { projectId: string; outcomeId: string }) => Promise<ConversationUnit[]>;
  outcomesConversationCreate?: (request: { projectId: string; outcomeId: string; title?: string }) => Promise<{ id: string; title: string; createdAt: number } | null>;
  outcomesConversationDelete?: (request: { projectId: string; conversationId: string }) => Promise<boolean>;
  outcomesConversationById?: (request: { projectId: string; conversationId: string }) => Promise<Array<{ id: string; role: 'user' | 'assistant' | 'system'; content: string; sources: unknown[]; createdAt: number }>>;
};

const newWord = (): WordDocument => ({ type: 'word', blocks: [{ id: 'p-1', kind: 'paragraph', text: '' }], page: { paper: 'A4', lineSpacing: 1.5 }, header: '', footer: '' });
const newPpt = (): PptDocument => ({ type: 'ppt', ratio: '16:9', theme: {}, templateId: null, generationSkillId: null, pages: [{ id: 'slide-1', title: '封面', pageType: 'cover', humanModified: false, status: 'complete', elements: [] }] });
const makeDocument = (kind: OutcomeKind): OutcomeDocument => kind === 'word'
  ? newWord()
  : kind === 'ppt'
    ? newPpt()
    : kind === 'spreadsheet'
      ? { type: 'spreadsheet', media: null, originalArchiveMediaId: null, workbook: { sheetNames: [], activeSheet: null, activeCell: null, cells: {} } }
      : kind === 'pdf'
        ? { type: 'pdf', media: null, originalArchiveMediaId: null, pageCount: null, activePage: null }
        : { type: 'other', text: '', media: null };
const kindIcon = (kind: OutcomeKind) => kind === 'word' ? <FileText size={15} /> : kind === 'ppt' ? <Presentation size={15} /> : kind === 'spreadsheet' ? <FileSpreadsheet size={15} /> : kind === 'image' ? <ImageIcon size={15} /> : <FileText size={15} />;
const superNumber = (value: number) => String(value).split('').map((item) => '⁰¹²³⁴⁵⁶⁷⁸⁹'[Number(item)]).join('');
const asRecord = (value: unknown): Record<string, unknown> | null => value !== null && typeof value === 'object' && !Array.isArray(value) ? value as Record<string, unknown> : null;
const assistantBridge = (): OutcomeAssistantBridge | undefined => window.metis as unknown as OutcomeAssistantBridge | undefined;
const requestSelection = (selection: AssistantSelection): OutcomeAssistantRequestSelection | undefined => {
  if (!selection) return undefined;
  return selection.kind === 'word'
    ? selection.row !== undefined && selection.column !== undefined
      ? { type: 'word_table_cell', blockId: selection.blockId, row: selection.row, column: selection.column, ...(selection.start !== undefined ? { start: selection.start } : {}), ...(selection.end !== undefined ? { end: selection.end } : {}) }
      : { type: 'word_block', blockId: selection.blockId, ...(selection.start !== undefined ? { start: selection.start } : {}), ...(selection.end !== undefined ? { end: selection.end } : {}) }
     : selection.elementId ? { type: 'ppt_element', pageId: selection.pageId, elementId: selection.elementId } : { type: 'ppt_page', pageId: selection.pageId };
};
const wordSelectionStillExists = (selection: Extract<AssistantSelection, { kind: 'word' }>, document: WordDocument): boolean => {
  // Table cells are persisted as an unkeyed 2D string array, so row/column
  // coordinates cannot prove that the same semantic cell survived a save.
  if (selection.row !== undefined || selection.column !== undefined) return false;
  const block = document.blocks.find((candidate) => candidate.id === selection.blockId);
  if (!block) return false;
  const sourceText = block.text ?? '';
  if (selection.start === undefined && selection.end === undefined) return true;
  if (selection.start === undefined || selection.end === undefined || !Number.isInteger(selection.start) || !Number.isInteger(selection.end) || selection.start < 0 || selection.end < selection.start || selection.end > sourceText.length) return false;
  return sourceText.slice(selection.start, selection.end) === selection.text;
};
const docxWarningNotice = (warnings: OutcomeWordDocxWarning[]): string => warnings.length === 0 ? '' : `已完成可编辑导入，但有 ${warnings.length} 项未完全保真：${warnings.map((warning) => warning.message).join('；')}`;
const pptxWarningNotice = (warnings: OutcomePptxWarning[]): string => warnings.length === 0 ? '' : `已完成 PPTX 处理，但有 ${warnings.length} 项未完全保真：${warnings.map((warning) => warning.message).join('；')}`;
type ApplicablePptTemplate = { ratio?: PptDocument['ratio']; theme?: Record<string, unknown>; pages?: PptPage[] };
const copyTemplatePages = (pages: PptPage[]): PptPage[] => pages.map((page) => ({ ...page, elements: page.elements.map((element) => ({ ...element, props: structuredClone(element.props) })) }));
// The renderer-only placeholder injected for empty decks must never reach a
// saved version or a template definition; a page counts as placeholder only
// while the user has not touched it.
const isPristineFallbackPage = (page: PptPage): boolean => page.id === 'slide-empty' && !page.humanModified && page.elements.length === 0;
const withoutPristineFallbackPages = (document: PptDocument): PptDocument => ({ ...document, pages: document.pages.filter((page) => !isPristineFallbackPage(page)) });
const applicablePptTemplate = (template: PptTemplate, fallbackRatio: PptDocument['ratio']): { value?: ApplicablePptTemplate; message?: string } => {
  const definition = asRecord(template.definition);
  if (!definition) return { message: `模板「${template.name}」的数据结构无效，当前成果没有被修改。` };
  const decoded = decodePptTemplateDefinition(definition, fallbackRatio);
  if (!decoded) return { message: `模板「${template.name}」的比例、主题或页面布局数据无效，当前成果没有被修改。` };
  return { value: { ...decoded, ...(decoded.pages ? { pages: copyTemplatePages(decoded.pages) } : {}) } };
};
const imageGenerationFailureNotice = (code: string): string => ({
  invalid_request: '图片生成请求无效，当前成果没有被修改。',
  image_generation_unconfigured: '图片生成尚未在设置中完成 Provider、模型或密钥配置；本次没有生成图片。',
  image_generation_provider_failed: '图片生成服务没有完成请求，当前成果没有被修改。',
  image_generation_provider_http_error: '图片生成服务返回了错误响应，当前成果没有被修改。',
  image_generation_provider_response_invalid: '图片生成服务返回的图片无效，当前成果没有被修改。',
  image_generation_media_persist_failed: '生成图片未能持久化到当前成果的媒体区，当前成果没有被修改。',
  outcome_not_found: '当前成果已不可用，图片没有被写入。',
}[code] ?? `图片生成未完成：${code}`);
function mergeMessages(previous: ScopedMessage[], additions: Array<ScopedMessage | undefined>): ScopedMessage[] { const rows = new Map(previous.map((message) => [message.id, message])); additions.forEach((message) => { if (message?.id) rows.set(message.id, message); }); return [...rows.values()].sort((left, right) => left.createdAt - right.createdAt); }
function mergeRowsById<T extends { id: string }>(current: T[], loaded: T[]): T[] { const rows = new Map(loaded.map((item) => [item.id, item])); current.forEach((item) => rows.set(item.id, item)); return [...rows.values()]; }
const sourceKindLabel = (kind: string): string => ({
  selection: '当前选区', outcome_version: '成果版本', source: '项目资料', evidence: '证据', note_code: '笔记编码', claim: '论断', artifact: '项目产物', project_metis: '项目 METIS', upload: '上传文件',
}[kind] ?? kind);
const selectionContextLabel = (selection: AssistantSelection): string => {
  if (!selection) return '未附加局部选区';
  if (selection.kind === 'word') {
    const target = selection.row !== undefined && selection.column !== undefined
      ? `Word 表格 ${selection.blockId} 第 ${selection.row + 1} 行第 ${selection.column + 1} 列`
      : `Word 段落 ${selection.blockId}`;
    return selection.start !== undefined && selection.end !== undefined
      ? `${target}，字符 ${selection.start}–${selection.end}`
      : target;
  }
  return selection.elementId ? `PPT 页面 ${selection.pageId}，元素 ${selection.elementId}` : `PPT 页面 ${selection.pageId}`;
};
const selectedCharacterCount = (selection: AssistantSelection): number | undefined => selection?.kind === 'word' && selection.start !== undefined && selection.end !== undefined
  ? Math.max(0, selection.end - selection.start) : undefined;
function OutcomeSourceList({ sources, label, onOpenOutcomeVersion, onLocate }: { sources: readonly OutcomeSource[]; label: string; onOpenOutcomeVersion?: (source: OutcomeSource) => void; onLocate?: (source: OutcomeSource) => void }) {
  const locatable = (kind: string): boolean => kind === 'artifact' || kind === 'project_metis' || kind === 'outcome_version';
  return <section className="outcome-source-list" aria-label={label}>
    <small>{label}</small>
    {sources.length === 0 ? <p>无额外资料</p> : <ul>{sources.map((source, index) => <li key={`${source.kind}-${source.id}-${source.version ?? 'none'}-${index}`}>
      <strong>{source.label}</strong>
      <span>类型：{sourceKindLabel(source.kind)}（{source.kind}）{source.version !== undefined ? ` · v${source.version}` : ''}</span>
      {source.kind === 'outcome_version' && source.version !== undefined && onOpenOutcomeVersion && <button type="button" onClick={() => onOpenOutcomeVersion(source)} aria-label={`打开来源成果 ${source.label}`}>打开成果版本</button>}
      {locatable(source.kind) && onLocate && <button type="button" onClick={() => onLocate(source)} aria-label={`定位来源 ${source.label}`}>定位</button>}
    </li>)}</ul>}
  </section>;
}

export default function OutcomesPage({ onNavigateToSubmissions }: { onNavigateToSubmissions?: () => void } = {}) {
  const projectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const projects = useResearchWorkspaceStore((state) => state.projects);
  const project = projects.find((item) => item.id === projectId);
  const [submissionOpen, setSubmissionOpen] = useState(false);
  const [categories, setCategories] = useState<OutcomeCategory[]>([]);
  const [items, setItems] = useState<OutcomeSummary[]>([]);
  const [selected, setSelected] = useState<OutcomeDetail | null>(null);
  const [versions, setVersions] = useState<OutcomeVersion[]>([]);
  const [editorDocument, setEditorDocument] = useState<OutcomeDocument | null>(null);
  const [assistantSelection, setAssistantSelection] = useState<AssistantSelection>();
  const assistantSelectionRef = useRef<AssistantSelection>(undefined);
  const updateAssistantSelection = useCallback((selection: AssistantSelection) => {
    assistantSelectionRef.current = selection;
    setAssistantSelection(selection);
  }, []);
  const [assistantHistoryRevision, setAssistantHistoryRevision] = useState(0);
  const [isWordDocxImporting, setIsWordDocxImporting] = useState(false);
  const [isPptxImporting, setIsPptxImporting] = useState(false);
  const [isPptxExporting, setIsPptxExporting] = useState(false);
  const wordDocxImportInFlight = useRef(false);
  const pptxImportInFlight = useRef(false);
  const pptxExportInFlight = useRef(false);
  const [operationNotice, setOperationNotice] = useState('');
  const [formattingOpenRequest, setFormattingOpenRequest] = useState(0);
  const [externalEditorSession, setExternalEditorSession] = useState<{ token: string; outcomeId: string; kind: 'word' | 'ppt' | 'spreadsheet' | 'pdf'; fileName: string } | null>(null);
  // 嵌入式视图（已停用）：保留状态供将来重启该方案；当前 Metis Office 走独立窗口。
  const [embeddedViewId, setEmbeddedViewId] = useState<number | null>(null);
  const embeddedStageRef = useRef<HTMLDivElement | null>(null);
  const externalEditorSessionRef = useRef<typeof externalEditorSession>(null);
  const [externalEditorBusy, setExternalEditorBusy] = useState(false);
  const [createOpen, setCreateOpen] = useState(false);
  const [query, setQuery] = useState('');
  const [categoryPrompt, setCategoryPrompt] = useState<{ mode: 'create' } | { mode: 'rename'; categoryId: string; initialName: string } | null>(null);
  // ── 任务4 统一 Async View State：列表加载 loading / error / stale 三态 ──
  // 首次加载失败 → listState='error'（可重试，绝不冒充空列表）；
  // 已有数据刷新失败 → 保留旧列表 + listStale 提示"当前显示上次成功加载的数据"。
  const [listState, setListState] = useState<'loading' | 'ready' | 'error'>('loading');
  const [listStale, setListStale] = useState(false);
  const [listRetrying, setListRetrying] = useState(false);
  // 任务4：新建成果对话框提交防双击。
  const [createBusy, setCreateBusy] = useState(false);
  // 任务4：复制成果防双击。
  const [duplicateBusy, setDuplicateBusy] = useState(false);
  // 任务4：标记最终版防双击。
  const [markFinalBusy, setMarkFinalBusy] = useState(false);
  // 任务4：保存版本防双击（保存进行中禁用按钮）。
  const [saveBusy, setSaveBusy] = useState(false);

  const loadOutcomes = useCallback(async (phase: 'initial' | 'refresh') => {
    if (!projectId || !window.metis) return;
    if (phase === 'initial') setListState((state) => (state === 'ready' ? 'ready' : 'loading'));
    else setListRetrying(true);
    try {
      const [nextCategories, nextItems] = await Promise.all([
        window.metis.listOutcomeCategories(),
        window.metis.listOutcomes({ projectId, query: '' }),
      ]);
      setCategories(nextCategories as OutcomeCategory[]);
      setItems(nextItems as OutcomeSummary[]);
      setListState('ready');
      setListStale(false);
    } catch (error) {
      console.error('[OutcomesPage] list load failed:', error);
      if (phase === 'initial') setListState('error');
      else setListStale(true);
    } finally {
      setListRetrying(false);
    }
  }, [projectId]);

  const refresh = useCallback(async () => {
    // refresh 是 mutation 后的再同步：失败必须保留旧数据并标 stale，不得静默清空。
    await loadOutcomes('refresh');
  }, [loadOutcomes]);

  // ── 成果回收站（2026-08-24）：软删除进回收站，7 天到期由主进程惰性彻底删除 ──
  const [trashOpen, setTrashOpen] = useState(false);
  const [trashItems, setTrashItems] = useState<OutcomeTrashEntry[]>([]);
  const [trashConfirmId, setTrashConfirmId] = useState<string | null>(null);
  const [trashOpenedAt, setTrashOpenedAt] = useState(0);

  const loadTrash = useCallback(async () => {
    if (!projectId || !window.metis?.listOutcomeTrash) return;
    setTrashItems(await window.metis.listOutcomeTrash({ projectId }) as OutcomeTrashEntry[]);
  }, [projectId]);
  const openTrash = useCallback(async () => { setTrashConfirmId(null); setTrashOpenedAt(Date.now()); setTrashOpen(true); await loadTrash(); }, [loadTrash]);
  const archiveOutcome = useCallback(async (item: OutcomeSummary) => {
    if (!projectId || !window.metis?.archiveOutcome) return;
    if (externalEditorSession?.outcomeId === item.id) {
      const state = window.metis.stateOutcomeGenofficeEditor
        ? await window.metis.stateOutcomeGenofficeEditor({ projectId, outcomeId: item.id })
        : { exists: true, changed: false, session: null };
      if (state.changed) { setOperationNotice('外部文件有未同步修改，请先同步回 METIS 或明确放弃会话。'); return; }
      const token = state.session?.token ?? externalEditorSession.token;
      if (!await window.metis.closeOutcomeGenofficeEditor?.({ projectId, outcomeId: item.id, token })) {
        setOperationNotice('Metis Office 会话未能关闭，成果仍未移入回收站。'); return;
      }
      setExternalEditorSession(null);
    }
    const ok = await window.metis.archiveOutcome({ projectId, outcomeId: item.id });
    if (!ok) { setOperationNotice('移入回收站未完成，成果未被删除。'); return; }
    if (selected?.outcome.id === item.id) { setSelected(null); setEditorDocument(null); setVersions([]); updateAssistantSelection(undefined); }
    // 已移入回收站：清掉"上次选中"记忆，避免下次进入尝试打开已删除成果。
    try { window.localStorage.removeItem(`metis:outcomes-selected:${projectId}`); } catch { /* best-effort */ }
    setOperationNotice(`「${item.title}」已移入回收站，7 天后自动彻底删除；可在回收站恢复。`);
    await refresh();
  }, [externalEditorSession, projectId, refresh, selected, updateAssistantSelection]);
  const restoreTrashOutcome = useCallback(async (outcomeId: string) => {
    if (!projectId || !window.metis?.restoreOutcomeFromTrash) return;
    const ok = await window.metis.restoreOutcomeFromTrash({ projectId, outcomeId });
    if (!ok) { setOperationNotice('恢复未完成，请刷新回收站后重试。'); return; }
    setOperationNotice('成果已从回收站恢复。');
    await Promise.all([loadTrash(), refresh()]);
  }, [loadTrash, projectId, refresh]);
  const deleteTrashOutcomeForever = useCallback(async (outcomeId: string) => {
    if (!projectId || !window.metis?.deleteOutcomePermanent) return;
    if (externalEditorSession?.outcomeId === outcomeId) {
      const state = window.metis.stateOutcomeGenofficeEditor
        ? await window.metis.stateOutcomeGenofficeEditor({ projectId, outcomeId })
        : { exists: true, changed: false, session: null };
      if (state.changed) { setOperationNotice('外部文件有未同步修改，请先同步回 METIS 或明确放弃会话。'); return; }
      const token = state.session?.token ?? externalEditorSession.token;
      if (!await window.metis.closeOutcomeGenofficeEditor?.({ projectId, outcomeId, token })) {
        setOperationNotice('Metis Office 会话未能关闭，成果仍保留在回收站。'); return;
      }
      setExternalEditorSession(null);
    }
    const ok = await window.metis.deleteOutcomePermanent({ projectId, outcomeId });
    if (!ok) { setOperationNotice('彻底删除未完成，成果仍保留在回收站。'); return; }
    setTrashConfirmId(null);
    setOperationNotice('成果及其源文件已彻底删除。');
    await loadTrash();
  }, [externalEditorSession, loadTrash, projectId]);

  useEffect(() => {
    let current = true;
    void (async () => {
      if (!projectId || !window.metis) return;
      if (!current) return;
      await loadOutcomes('initial');
      // 任务4 第十一节：切走再回来恢复上次选中的成果（open 对已删除的成果自会空处理）。
      if (!current) return;
      const stickyId = readStickyValue(`metis:outcomes-selected:${projectId}`);
      if (stickyId && !selected?.outcome.id) void openRef.current?.(stickyId);
    })();
    return () => { current = false; };
  // eslint-disable-next-line react-hooks/exhaustive-deps -- 初始加载仅依赖 projectId；open 通过 ref 取最新
  }, [projectId, loadOutcomes]);
  useEffect(() => { externalEditorSessionRef.current = externalEditorSession; }, [externalEditorSession]);

  // Metis Office 关闭自动同步（2026-09-01 刘总要求）：编辑器一关，主进程
  // 已自动同步/收尾并推送结果——这里刷新列表与版本，并清掉本地会话状态。
  const projectIdForAutoSyncRef = useRef(projectId);
  projectIdForAutoSyncRef.current = projectId;
  const refreshForAutoSyncRef = useRef<(() => Promise<void>) | undefined>(undefined);
  refreshForAutoSyncRef.current = refresh;
  useEffect(() => {
    const unsubscribe = window.metis?.onOutcomeExternalEditorAutoSync?.((payload) => {
      if (payload.projectId !== projectIdForAutoSyncRef.current) return;
      setExternalEditorSession(null);
      setEmbeddedViewId(null);
      void refreshForAutoSyncRef.current?.();
      if (payload.ok && payload.changed && payload.version !== undefined) {
        setOperationNotice(payload.message || `检测到 Metis Office 已关闭，改动已自动同步为新版本 v${payload.version}。`);
      } else if (payload.ok) {
        setOperationNotice(payload.message || 'Metis Office 已关闭：内容没有修改，会话已自动结束。');
      } else {
        setOperationNotice(payload.message || 'Metis Office 已关闭，自动同步没有完成。');
      }
    });
    return () => unsubscribe?.();
  }, []);

  const open = useCallback(async (id: string, version?: number) => {
    if (!projectId || !window.metis) return;
    if (externalEditorSession && externalEditorSession.outcomeId !== id) {
      const state = window.metis.stateOutcomeGenofficeEditor
        ? await window.metis.stateOutcomeGenofficeEditor({ projectId, outcomeId: externalEditorSession.outcomeId })
        : { exists: true, changed: false, session: null };
      if (state.changed) { setOperationNotice('外部文件有未同步修改，请先同步回 METIS 或明确放弃会话。'); return; }
      const token = state.session?.token ?? externalEditorSession.token;
      if (!await window.metis.closeOutcomeGenofficeEditor?.({ projectId, outcomeId: externalEditorSession.outcomeId, token })) {
        setOperationNotice('Metis Office 会话未能关闭，当前成果未切换。'); return;
      }
      setExternalEditorSession(null);
    }
    const detail = await window.metis.getOutcome({ projectId, outcomeId: id, ...(version ? { version } : {}) }).catch((error) => {
      console.error('[OutcomesPage] open outcome failed:', error);
      setOperationNotice('打开成果未完成，成果未被修改；可直接重试。');
      return null;
    });
    if (!detail) return;
    const typed = detail as OutcomeDetail;
    setSelected(typed); setEditorDocument(typed.version.content); updateAssistantSelection(undefined); setOperationNotice('');
    // 任务4 第十一节：记住当前项目里上次打开的成果，切走再回来不重置。
    try { window.localStorage.setItem(`metis:outcomes-selected:${projectId}`, typed.outcome.id); } catch { /* best-effort */ }
    try {
      setVersions(await window.metis.listOutcomeVersions({ projectId, outcomeId: id }) as OutcomeVersion[]);
    } catch (error) {
      console.error('[OutcomesPage] list versions failed:', error);
      setVersions([]);
    }
  }, [externalEditorSession, projectId, updateAssistantSelection]);
  // open 定义于其后使用前的场景（初始 sticky 恢复 effect）：经 ref 取最新版本。
  const openRef = useRef<typeof open>(undefined);
  useEffect(() => { openRef.current = open; }, [open]);
  const performSave = useCallback(async (content: OutcomeDocument, note = '保存编辑', actor: 'human' | 'ai' | 'import' | 'restore' = 'human', sources: OutcomeSource[] = [], importToken?: string) => {
    if (!projectId || !selected || !window.metis) return false;
    if (externalEditorSession?.outcomeId === selected.outcome.id) {
      setOperationNotice('当前成果正在 Metis Office 中编辑。请先同步回 METIS 或放弃外部编辑会话，再保存本地草稿。');
      return false;
    }
    setOperationNotice('');
    // Promise.resolve 包一层：IPC 缺失或测试桩返回非 Promise 时不至于抛 TypeError。
    const saved = await Promise.resolve(window.metis.saveOutcome({ projectId, outcomeId: selected.outcome.id, baseVersion: selected.outcome.currentVersion, content, note, actor, sources, ...(importToken ? { importToken } : {}) })).catch((error) => {
      console.error('[OutcomesPage] saveOutcome failed:', error);
      return null;
    });
    const parsed = OutcomeDetailSchema.safeParse(saved);
    if (!parsed.success) { setOperationNotice('保存未完成（可能是版本已更新或运行服务不可用）。当前未保存编辑仍保留在页面，请检查后重试。'); return false; }
     setSelected(parsed.data); setEditorDocument(parsed.data.version.content);
      const selection = assistantSelectionRef.current;
     const selectionStillExists = selection?.kind === 'word'
       ? parsed.data.version.content.type === 'word' && wordSelectionStillExists(selection, parsed.data.version.content)
       : selection?.kind === 'ppt'
         ? parsed.data.version.content.type === 'ppt' && parsed.data.version.content.pages.some((page) => page.id === selection.pageId && (!selection.elementId || page.elements.some((element) => element.id === selection.elementId)))
         : false;
      updateAssistantSelection(selectionStillExists ? selection : undefined);
     try {
       setVersions(await window.metis.listOutcomeVersions({ projectId, outcomeId: parsed.data.outcome.id }) as OutcomeVersion[]);
     } catch (error) {
       console.error('[OutcomesPage] list versions failed:', error);
       setVersions([]);
     }
    await refresh(); return true;
     }, [externalEditorSession, projectId, refresh, selected, updateAssistantSelection]);
  const save = useCallback(async (content: OutcomeDocument, note = '保存编辑', actor: 'human' | 'ai' | 'import' | 'restore' = 'human', sources: OutcomeSource[] = [], importToken?: string) => {
    if (!projectId || !selected || !window.metis) return false;
    if (saveBusy) { setOperationNotice('上一次保存仍在进行中，请稍候。'); return false; } // 任务4：防双击/防并发保存。
    setSaveBusy(true);
    try {
      return await performSave(content, note, actor, sources, importToken);
    } finally {
      setSaveBusy(false);
    }
  }, [saveBusy, performSave, projectId, selected]);
  const create = useCallback(async (kind: OutcomeKind, title: string, categoryId: string | null) => {
    if (!projectId || !window.metis || !title.trim()) return;
    if (createBusy) return; // 任务4：防双击——同一时刻只允许一个创建请求。
    setCreateBusy(true);
    try {
      const created = await window.metis.createOutcome({ projectId, kind, title: title.trim(), categoryId, content: makeDocument(kind), note: '创建成果' });
      if (!created) {
        setOperationNotice('成果创建未完成，未被创建；请重试。');
        return;
      }
      setCreateOpen(false); await refresh(); await open((created as OutcomeDetail).outcome.id);
    } catch (error) {
      console.error('[OutcomesPage] create outcome failed:', error);
      setOperationNotice('成果创建未完成，未被创建；请重试。');
    } finally {
      setCreateBusy(false);
    }
  }, [createBusy, open, projectId, refresh]);
  const submitCategoryPrompt = useCallback(async (rawName: string) => {
    const pending = categoryPrompt;
    const name = rawName.trim();
    setCategoryPrompt(null);
    if (!pending || !name || !window.metis) return;
    try {
      if (pending.mode === 'rename') await window.metis.renameOutcomeCategory({ categoryId: pending.categoryId, name });
      else await window.metis.createOutcomeCategory({ name });
    } catch (error) {
      console.error('[OutcomesPage] category write failed:', error);
      setOperationNotice(pending.mode === 'rename' ? '分类重命名未完成，分类未改动；请重试。' : '分类创建未完成；请重试。');
      return;
    }
    await refresh();
  }, [categoryPrompt, refresh]);
  // 刘总规格：用户可删除自建分类；删除后该分类下的成果由数据库外键 ON DELETE SET NULL 自动回落「未分类」，成果本身不删除。
  const deleteCategory = useCallback(async (category: OutcomeCategory) => {
    if (!window.metis) return;
    if (!window.confirm(`删除分类「${category.name}」？该分类下的成果会移回「未分类」，成果本身不会被删除。`)) return;
    try {
      if (!await window.metis.deleteOutcomeCategory({ categoryId: category.id })) { setOperationNotice('分类删除未完成，分类仍保留；请重试。'); return; }
    } catch (error) {
      console.error('[OutcomesPage] category delete failed:', error);
      setOperationNotice('分类删除未完成，分类仍保留；请重试。');
      return;
    }
    await refresh();
  }, [refresh]);
  useEffect(() => {
    if (!operationNotice) return undefined;
    const timer = window.setTimeout(() => setOperationNotice(''), 8000);
    return () => { window.clearTimeout(timer); };
  }, [operationNotice]);
  const restoreVersion = useCallback(async (version: OutcomeVersion) => {
    if (!projectId || !selected || !window.metis) return;
    setOperationNotice('');
    const restored = await window.metis.restoreOutcome({ projectId, outcomeId: selected.outcome.id, version: version.version, note: `恢复到 v${version.version}` });
    const parsed = OutcomeDetailSchema.safeParse(restored);
    if (!parsed.success) { setOperationNotice('恢复未完成，当前编辑仍保留在页面；没有创建新的恢复版本。请刷新版本列表后重试。'); return; }
    setSelected(parsed.data); setEditorDocument(parsed.data.version.content); updateAssistantSelection(undefined);
    setVersions(await window.metis.listOutcomeVersions({ projectId, outcomeId: parsed.data.outcome.id }) as OutcomeVersion[]);
    await refresh();
  }, [projectId, refresh, selected, updateAssistantSelection]);
  const moveOutcome = useCallback(async (outcomeId: string, categoryId: string | null) => {
    if (!projectId || !window.metis) return;
    try {
      if (await window.metis.moveOutcome({ projectId, outcomeId, categoryId })) await refresh();
      else setOperationNotice('成果移动未完成，仍留在原分类；请重试。');
    } catch (error) {
      console.error('[OutcomesPage] move outcome failed:', error);
      setOperationNotice('成果移动未完成，仍留在原分类；请重试。');
    }
  }, [projectId, refresh]);
  const duplicateCurrent = useCallback(async () => {
    if (!selected || !projectId || !window.metis) return;
    if (duplicateBusy) return; // 任务4：防双击。
    setDuplicateBusy(true);
    try {
      const title = `${selected.outcome.title} 副本`;
      const created = await window.metis.createOutcome({ projectId, kind: selected.outcome.kind, title, categoryId: selected.outcome.categoryId, content: editorDocument ?? selected.version.content, note: `从 ${selected.outcome.title} 复制`, applyDefaultTemplate: false });
      if (!created) { setOperationNotice('复制未完成，副本未被创建；请重试。'); return; }
      await refresh(); await open((created as OutcomeDetail).outcome.id);
    } catch (error) {
      console.error('[OutcomesPage] duplicate outcome failed:', error);
      setOperationNotice('复制未完成，副本未被创建；请重试。');
    } finally {
      setDuplicateBusy(false);
    }
  }, [editorDocument, open, projectId, refresh, selected, duplicateBusy]);
  const applyAssistantVersion = useCallback(async (applied: AssistantApplied | undefined) => {
    const raw = asRecord(applied); if (!raw) return;
    const parsed = OutcomeDetailSchema.safeParse({ outcome: raw.outcome, version: raw.version });
    if (!parsed.success) return;
    setSelected(parsed.data); setEditorDocument(parsed.data.version.content); updateAssistantSelection(undefined);
    if (window.metis) setVersions(await window.metis.listOutcomeVersions({ projectId: parsed.data.outcome.projectId, outcomeId: parsed.data.outcome.id }) as OutcomeVersion[]);
    await refresh();
  }, [refresh, updateAssistantSelection]);
  const selectedForProject = selected?.outcome.projectId === projectId ? selected : null;
  const hasUnsavedChanges = Boolean(selectedForProject && editorDocument && JSON.stringify(editorDocument) !== JSON.stringify(selectedForProject.version.content));
  const openOutcomeSource = useCallback((source: OutcomeSource) => {
    if (source.kind !== 'outcome_version' || source.version === undefined) return;
    if (hasUnsavedChanges) {
      setOperationNotice('当前成果有未保存的编辑。请先保存版本，再打开来源成果，避免丢失本地草稿。');
      return;
    }
    void open(source.id, source.version);
  }, [hasUnsavedChanges, open]);
  const locateSource = useCallback((source: OutcomeSource) => {
    if (!projectId || !window.metis?.locateOutcomeSource) {
      setOperationNotice('当前界面无法定位该来源（定位服务不可用）。');
      return;
    }
    setOperationNotice('');
    void window.metis.locateOutcomeSource({ projectId, outcomeId: selected?.outcome.id ?? '', source }).then((located) => {
      if (located && located.ok) {
        if (located.kind === 'artifact') {
          navigate({ kind: 'project', projectId, section: 'artifacts' }); // 任务4：typed navigation contract
          setOperationNotice(`已定位研究资料：${located.targetId}（已在项目资料区打开）。`);
        } else {
          setOperationNotice(`已定位：${located.label}`);
        }
      } else {
        const code = located && !located.ok ? located.code : 'source_not_found';
        setOperationNotice(code === 'source_not_locatable'
          ? '该来源当前无法在界面中定位；本次修改仅记录了它的来源标识。'
          : '未找到该来源对应的可打开内容。');
      }
    });
  }, [projectId, selected]);
  const importWordDocx = useCallback(async () => {
    if (!projectId || !window.metis?.importOutcomeWordDocx || !window.metis.commitOutcomeWordDocxImportMedia || isWordDocxImporting || wordDocxImportInFlight.current) return;
    const currentWord = selected?.outcome.projectId === projectId && selected.outcome.kind === 'word' ? selected : null;
    if (hasUnsavedChanges || (currentWord && editorDocument && JSON.stringify(editorDocument) !== JSON.stringify(currentWord.version.content))) { setOperationNotice('当前 Word 有未保存的编辑。请先保存版本，再导入 DOCX，避免覆盖本地草稿。'); return; }
    wordDocxImportInFlight.current = true; setIsWordDocxImporting(true);
    try {
      const imported = await window.metis.importOutcomeWordDocx({ projectId });
      if (!imported.ok) { if (imported.code !== 'cancelled') setOperationNotice(imported.message); return; }
      const warnings = docxWarningNotice(imported.warnings);
      const committedMedia = await window.metis.commitOutcomeWordDocxImportMedia({ projectId, importToken: imported.importToken, ...(currentWord ? { outcomeId: currentWord.outcome.id } : {}), document: imported.document });
      if (!committedMedia || !committedMedia.ok) { setOperationNotice(committedMedia && !committedMedia.ok ? committedMedia.message : 'DOCX 图片没有写入成果媒体区；当前成果没有被修改。'); return; }
      if (currentWord) {
        const committed = await save(committedMedia.document, `导入 ${imported.fileName}`, 'import', [], imported.importToken);
        if (committed) setOperationNotice(`已导入 ${imported.fileName} 并保存为新版本。${warnings}`);
        return;
      }
      const title = imported.fileName.replace(/\.docx$/iu, '').trim() || '导入 Word 文档';
      const created = await window.metis.createOutcome({ projectId, outcomeId: committedMedia.outcomeId, categoryId: null, title, kind: 'word', content: committedMedia.document, note: `导入 ${imported.fileName}`, actor: 'import', importToken: imported.importToken });
      const parsed = OutcomeDetailSchema.safeParse(created);
      if (!parsed.success) { setOperationNotice('DOCX 已读取并完成媒体提交，但未能创建成果版本；当前成果内容没有被修改。'); return; }
      await refresh(); await open(parsed.data.outcome.id); setOperationNotice(`已导入 ${imported.fileName} 并创建成果 v1。${warnings}`);
    } catch { setOperationNotice('DOCX 导入请求没有完成；当前成果没有被修改。'); }
    finally { wordDocxImportInFlight.current = false; setIsWordDocxImporting(false); }
  }, [editorDocument, hasUnsavedChanges, isWordDocxImporting, open, projectId, refresh, save, selected]);
  const exportWordDocx = useCallback(async () => {
    if (!projectId || !selected || selected.outcome.kind !== 'word' || !window.metis?.exportOutcomeWordDocx) return;
    if (editorDocument && JSON.stringify(editorDocument) !== JSON.stringify(selected.version.content)) { setOperationNotice('当前 Word 有未保存的编辑。请先保存版本，再导出 DOCX。'); return; }
    const exported = await window.metis.exportOutcomeWordDocx({ projectId, outcomeId: selected.outcome.id, version: selected.version.version });
    if (!exported.ok) { if (exported.code !== 'cancelled') setOperationNotice(exported.message); return; }
    const warnings = docxWarningNotice(exported.warnings);
    setOperationNotice(`已导出 ${exported.fileName}。${warnings}`);
  }, [editorDocument, projectId, selected]);
  const importPptx = useCallback(async () => {
    if (!projectId || !window.metis?.importOutcomePptx || isPptxImporting || pptxImportInFlight.current) return;
    if (hasUnsavedChanges) { setOperationNotice('当前成果有未保存的编辑。请先保存版本，再导入 PPTX，避免覆盖本地草稿。'); return; }
    const currentPpt = selected?.outcome.projectId === projectId && selected.outcome.kind === 'ppt' ? selected : null;
    pptxImportInFlight.current = true; setIsPptxImporting(true);
    try {
      const imported = await window.metis.importOutcomePptx({ projectId });
      if (!imported.ok) { setOperationNotice(imported.message); return; }
      const warnings = pptxWarningNotice(imported.warnings);
      if (!window.metis.commitOutcomePptxImportMedia) {
        setOperationNotice('当前版本缺少 PPTX 图片保存桥接；预览已完成，但没有写入成果或媒体。');
        return;
      }
      const committedMedia = await window.metis.commitOutcomePptxImportMedia({ projectId, importToken: imported.importToken, ...(currentPpt ? { outcomeId: currentPpt.outcome.id } : {}), document: imported.document });
      if (!committedMedia || !committedMedia.ok) {
        setOperationNotice(committedMedia && !committedMedia.ok ? committedMedia.message : 'PPTX 图片没有写入成果媒体区；当前成果没有被修改。');
        return;
      }
      if (currentPpt) {
        const committed = await save(committedMedia.document, `导入 ${imported.fileName}`, 'import', [], imported.importToken);
        if (committed) setOperationNotice(`已导入 ${imported.fileName} 并保存为新版本。${warnings}`);
        return;
      }
      const title = imported.fileName.replace(/\.pptx$/iu, '').trim() || '导入 PPT 演示文稿';
      const created = await window.metis.createOutcome({ projectId, outcomeId: committedMedia.outcomeId, categoryId: null, title, kind: 'ppt', content: committedMedia.document, note: `导入 ${imported.fileName}`, actor: 'import', importToken: imported.importToken });
      const parsed = OutcomeDetailSchema.safeParse(created);
      if (!parsed.success) { setOperationNotice('PPTX 已读取，但未能创建成果版本；请重试，当前项目内容没有被修改。'); return; }
      await refresh(); await open(parsed.data.outcome.id); setOperationNotice(`已导入 ${imported.fileName} 并创建成果 v1。${warnings}`);
    } catch {
      setOperationNotice('PPTX 导入请求没有完成，当前成果没有被修改。');
    } finally { pptxImportInFlight.current = false; setIsPptxImporting(false); }
  }, [hasUnsavedChanges, isPptxImporting, open, projectId, refresh, save, selected]);
  const exportPptx = useCallback(async () => {
    if (!projectId || !selected || selected.outcome.kind !== 'ppt' || !window.metis?.exportOutcomePptx || isPptxExporting || pptxExportInFlight.current) return;
    if (hasUnsavedChanges) { setOperationNotice('当前 PPT 有未保存的编辑。请先保存版本，再导出 PPTX。'); return; }
    pptxExportInFlight.current = true; setIsPptxExporting(true);
    try {
      const exported = await window.metis.exportOutcomePptx({ projectId, outcomeId: selected.outcome.id, version: selected.version.version });
      if (!exported.ok) { setOperationNotice(exported.message); return; }
      setOperationNotice(`已导出 ${exported.fileName}。${pptxWarningNotice(exported.warnings)}`);
    } catch {
      setOperationNotice('PPTX 导出请求没有完成，当前成果没有被修改。');
    } finally { pptxExportInFlight.current = false; setIsPptxExporting(false); }
  }, [hasUnsavedChanges, isPptxExporting, projectId, selected]);
  const openInGenoffice = useCallback(async (options?: { embedded?: boolean }) => {
    const embedded = options?.embedded === true;
    if (!projectId || !selectedForProject || !window.metis?.openOutcomeInGenoffice) return;
    if (hasUnsavedChanges) { setOperationNotice('当前成果有未保存的编辑。请先保存版本，再交给 Metis Office 编辑，避免覆盖本地草稿。'); return; }
    setExternalEditorBusy(true);
    try {
      const result = await window.metis.openOutcomeInGenoffice({ projectId, outcomeId: selectedForProject.outcome.id, version: selectedForProject.version.version, ...(embedded ? { embedded: true } : {}) });
      if (!result.ok) { setOperationNotice(result.message); return; }
      setExternalEditorSession({ ...result.session, outcomeId: selectedForProject.outcome.id });
      if (embedded && typeof result.webContentsId === 'number') {
        setEmbeddedViewId(result.webContentsId);
        setOperationNotice(`已在页面内打开「${result.session.fileName}」原生编辑器；保存并关闭后改动会自动同步回 METIS，也可随时手动同步。`);
      } else {
        setEmbeddedViewId(null);
        setOperationNotice(`已在 Metis Office 中打开「${result.session.fileName}」。保存并关闭 Metis Office 后改动会自动同步回 METIS，也可随时手动同步。`);
      }
    } catch { setOperationNotice('Metis Office 编辑器没有成功打开当前成果，当前版本没有被修改。'); }
    finally { setExternalEditorBusy(false); }
  }, [hasUnsavedChanges, projectId, selectedForProject]);
  const syncFromGenoffice = useCallback(async () => {
    if (!projectId || !externalEditorSession || !window.metis?.syncOutcomeFromGenoffice || externalEditorBusy) return;
    setExternalEditorBusy(true);
    try {
      const result = await window.metis.syncOutcomeFromGenoffice({ projectId, outcomeId: externalEditorSession.outcomeId, token: externalEditorSession.token });
      if (!result.ok) { setOperationNotice(result.message); return; }
      setSelected(result.detail);
      setEditorDocument(result.detail.version.content);
      setVersions(await window.metis.listOutcomeVersions({ projectId, outcomeId: result.detail.outcome.id }) as OutcomeVersion[]);
      if (!result.warning) { setExternalEditorSession(null); setEmbeddedViewId(null); }
      await refresh();
       setOperationNotice(`已将 Metis Office 保存的「${externalEditorSession.fileName}」同步为 METIS v${result.detail.version.version}。${result.warning ? ` ${result.warning}` : ''}`);
    } catch { setOperationNotice('Metis Office 文件同步没有完成，当前成果版本没有被修改。'); }
    finally { setExternalEditorBusy(false); }
  }, [externalEditorBusy, externalEditorSession, projectId, refresh]);
  const closeGenofficeEditor = useCallback(async () => {
    if (!projectId || !externalEditorSession || !window.metis?.closeOutcomeGenofficeEditor || externalEditorBusy) return;
    setExternalEditorBusy(true);
    try {
      const closed = await window.metis.closeOutcomeGenofficeEditor({ projectId, outcomeId: externalEditorSession.outcomeId, token: externalEditorSession.token });
      if (closed) { setExternalEditorSession(null); setEmbeddedViewId(null); setOperationNotice('已关闭 Metis Office 会话；未同步的外部文件没有写入 METIS。'); }
      else setOperationNotice('Metis Office 会话未能关闭；未同步内容仍未写入 METIS。');
    } catch { setOperationNotice('Metis Office 会话关闭失败；当前成果版本没有被修改。'); }
    finally { setExternalEditorBusy(false); }
  }, [externalEditorBusy, externalEditorSession, projectId]);
  const selectedOutcomeId = selectedForProject?.outcome.id;
  const nativeEmbeddedActive = Boolean(
    embeddedViewId !== null
    && externalEditorSession?.outcomeId === selectedOutcomeId
    && selectedForProject
    && ['word', 'ppt', 'spreadsheet', 'pdf'].includes(selectedForProject.outcome.kind),
  );
  // 内嵌 WebContentsView 方案已停用（黑屏未解）；Metis Office 以独立窗口为唯一入口。
  // 几何上报：嵌入视图悬浮于 DOM 之上，矩形必须逐帧跟随占位节点。
  useEffect(() => {
    if (embeddedViewId === null) return undefined;
    let observer: ResizeObserver | undefined;
    let settle: ReturnType<typeof setTimeout> | undefined;
    const report = () => {
      const node = embeddedStageRef.current;
      if (!node) return;
      const rect = node.getBoundingClientRect();
      if (rect.width < 8 || rect.height < 8) return;
      void window.metis?.genofficeEmbeddedSetBounds?.({
        webContentsId: embeddedViewId,
        rect: { x: rect.left, y: rect.top, width: rect.width, height: rect.height },
      });
    };
    const attach = () => {
      if (!embeddedStageRef.current) return false;
      report();
      observer = new ResizeObserver(report);
      observer.observe(embeddedStageRef.current);
      window.addEventListener('scroll', report, true);
      window.addEventListener('resize', report);
      settle = setTimeout(report, 250);
      return true;
    };
    // stage 节点与 viewId 分属两次渲染，首次拿不到就轮询补挂。
    if (!attach()) {
      const retry = setInterval(() => { if (attach()) clearInterval(retry); }, 100);
      return () => { clearInterval(retry); observer?.disconnect(); };
    }
    return () => {
      observer?.disconnect();
      window.removeEventListener('scroll', report, true);
      window.removeEventListener('resize', report);
      if (settle) clearTimeout(settle);
    };
  }, [embeddedViewId, nativeEmbeddedActive]);
  // METIS 弹层（排版面板/各对话框）出现时收起视图，避免原生画布盖住 DOM 弹层。
  useEffect(() => {
    if (embeddedViewId === null) return undefined;
    const check = () => {
      const blocked = Boolean(document.querySelector('.outcomes-modal-backdrop, .outcome-word-format-backdrop'));
      void window.metis?.genofficeEmbeddedSetVisible?.({ webContentsId: embeddedViewId, visible: !blocked });
    };
    check();
    const observer = new MutationObserver(check);
    observer.observe(document.body, { childList: true, subtree: true });
    return () => {
      observer.disconnect();
      void window.metis?.genofficeEmbeddedSetVisible?.({ webContentsId: embeddedViewId, visible: false });
    };
  }, [embeddedViewId]);
  useEffect(() => {
    if (!projectId || !selectedOutcomeId || externalEditorSession || !window.metis?.stateOutcomeGenofficeEditor) return undefined;
    let active = true;
    void window.metis.stateOutcomeGenofficeEditor({ projectId, outcomeId: selectedOutcomeId }).then((state) => {
      if (active && state.session) setExternalEditorSession({ ...state.session, outcomeId: selectedOutcomeId });
    });
    return () => { active = false; };
  }, [externalEditorSession, projectId, selectedOutcomeId]);
  const visible = useMemo(() => items.filter((item) => item.title.toLowerCase().includes(query.toLowerCase())), [items, query]);

  const outcomesPageRef = useRef<HTMLDivElement>(null);
  const [treeWidth, setTreeWidth] = useState(() => loadOutcomesWidth(OUTCOMES_TREE_WIDTH_KEY, 250, 190, 420));
  const [assistantWidth, setAssistantWidth] = useState(() => loadOutcomesWidth(OUTCOMES_ASSISTANT_WIDTH_KEY, 320, 260, 520));
  useEffect(() => { saveOutcomesWidth(OUTCOMES_TREE_WIDTH_KEY, treeWidth); }, [treeWidth]);
  useEffect(() => { saveOutcomesWidth(OUTCOMES_ASSISTANT_WIDTH_KEY, assistantWidth); }, [assistantWidth]);
  const handleTreeDrag = useCallback((clientX: number) => {
    const rect = outcomesPageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setTreeWidth(Math.min(420, Math.max(190, clientX - rect.left)));
  }, []);
  const handleAssistantDrag = useCallback((clientX: number) => {
    const rect = outcomesPageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setAssistantWidth(Math.min(520, Math.max(260, rect.right - clientX)));
  }, []);

  if (!projectId) return <div className="outcomes-empty"><FileText size={30} /><h2>成果属于科研项目</h2><p>请先选择一个科研项目，再管理论文、PPT、报告和正式交付物。</p></div>;
  return <div className="outcomes-page" ref={outcomesPageRef} style={{ '--outcomes-cols': `${treeWidth}px auto minmax(0, 1fr) auto ${assistantWidth}px` } as React.CSSProperties}>
    <aside className="outcomes-tree" aria-label="成果树">
      <header><div><small>当前项目</small><strong>{project?.title ?? projectId}</strong></div><div className="outcomes-tree__actions"><button type="button" onClick={() => void importWordDocx()} title="导入 Word DOCX" aria-label="导入 Word DOCX" disabled={isWordDocxImporting}>{isWordDocxImporting ? <LoaderCircle size={16} className="spin" /> : <Upload size={16} />}</button><button type="button" onClick={() => void importPptx()} title="导入 PPTX" aria-label="导入 PPTX" disabled={isPptxImporting}>{isPptxImporting ? <LoaderCircle size={16} className="spin" /> : <Presentation size={16} />}</button><button type="button" onClick={() => setCreateOpen(true)} title="新建成果" aria-label="新建成果"><Plus size={17} /></button></div></header>
      <input className="outcomes-search" value={query} onChange={(event) => setQuery(event.target.value)} placeholder="搜索成果" aria-label="搜索成果" />
      {listStale && !listRetrying && <StaleDataNotice onRetry={() => void loadOutcomes('refresh')} retrying={listRetrying} />}
      <div className="outcomes-tree-scroll">
        {listState === 'error' ? (
          <InlineError
            compact
            title="成果列表加载失败。"
            hint="成果数据没有丢失，只是暂时读不到。"
            onRetry={() => void loadOutcomes('initial')}
            retrying={listRetrying}
          />
        ) : listState === 'loading' ? (
          <QuietLoading compact label="正在加载成果…" />
        ) : (
          <>
            {categories.map((category) => <OutcomeCategorySection key={category.id} category={category} outcomes={visible.filter((item) => item.categoryId === category.id)} activeId={selectedForProject?.outcome.id} onOpen={open} onMove={moveOutcome} onTrash={(item) => void archiveOutcome(item)} onRename={() => setCategoryPrompt({ mode: 'rename', categoryId: category.id, initialName: category.name })} onDelete={() => void deleteCategory(category)} />)}
            <OutcomeCategorySection category={null} outcomes={visible.filter((item) => !item.categoryId)} activeId={selectedForProject?.outcome.id} onOpen={open} onMove={moveOutcome} onTrash={(item) => void archiveOutcome(item)} />
            {items.length === 0 && (
              <EmptyState
                compact
                title="还没有成果"
                description="成果是当前项目的正式交付物（论文、PPT、报告）。用上方「新建成果」或导入 Word/PPTX 开始。"
              />
            )}
          </>
        )}
      </div>
      <div className="outcomes-tree-footer">
        <button className="outcomes-new-category" type="button" onClick={() => setCategoryPrompt({ mode: 'create' })}><Plus size={14} />新建分类</button>
        <button className="outcomes-trash-entry" type="button" onClick={() => void openTrash()} title="回收站：删除的成果保留 7 天" aria-label="打开成果回收站"><Trash2 size={14} />回收站</button>
      </div>
    </aside>
    <SplitHandle
      label="拖动调整成果树宽度"
      testId="outcomes-split-tree"
      onDrag={handleTreeDrag}
      onKeyDelta={(delta) => setTreeWidth((current) => Math.min(420, Math.max(190, current + delta)))}
    />
    <main className="outcomes-editor">
      {operationNotice && <p className="outcomes-operation-notice" role="status">{operationNotice}</p>}
      {!selectedForProject || !editorDocument ? <div className="outcomes-empty outcomes-empty--editor"><FileText size={34} /><h2>打开或创建成果</h2><p>成果是当前项目的正式交付物，不自动存放运行日志、缓存或工具中间结果。</p><button className="primary" type="button" onClick={() => setCreateOpen(true)}>新建成果</button></div> : <>
         <header className="outcomes-editor-head"><div>{kindIcon(selectedForProject.outcome.kind)}<div><input defaultValue={selectedForProject.outcome.title} key={selectedForProject.outcome.id} aria-label="成果名称" onBlur={async (event) => { const title = event.currentTarget.value.trim(); if (title && title !== selectedForProject.outcome.title && window.metis) { try { await window.metis.renameOutcome({ projectId, outcomeId: selectedForProject.outcome.id, title }); } catch (error) { console.error('[OutcomesPage] rename failed:', error); setOperationNotice('重命名未完成，标题未改动；请重试。'); return; } await refresh(); } }} /><small>v{selectedForProject.version.version} · {selectedForProject.outcome.status === 'final' ? '最终版' : '草稿'}</small></div></div><div className="outcomes-editor-head__actions"><button className="primary" type="button" disabled={saveBusy} onClick={() => void save(editorDocument.type === 'ppt' ? withoutPristineFallbackPages(editorDocument) : editorDocument)}>{saveBusy ? <LoaderCircle size={15} className="spin" aria-hidden="true" /> : <Save size={15} />}保存版本</button>{selectedForProject.outcome.kind === 'word' && <button type="button" onClick={() => setFormattingOpenRequest((value) => value + 1)}><SlidersHorizontal size={14} />排版</button>}{selectedForProject.outcome.kind === 'word' && <button type="button" onClick={() => void exportWordDocx()}><FileText size={14} />导出 DOCX</button>}{selectedForProject.outcome.kind === 'ppt' && <button type="button" onClick={() => void exportPptx()} disabled={isPptxExporting}>{isPptxExporting ? <LoaderCircle size={14} className="spin" /> : <Presentation size={14} />}导出 PPTX</button>}<button type="button" onClick={() => setSubmissionOpen(true)} title="以当前版本创建投稿事务"><Send size={14} />投稿</button><button type="button" disabled={duplicateBusy} onClick={() => void duplicateCurrent()}><Copy size={14} />复制</button><button type="button" disabled={markFinalBusy} onClick={async () => { if (!window.metis || markFinalBusy) return; setMarkFinalBusy(true); try { await window.metis.markOutcomeFinal({ projectId, outcomeId: selectedForProject.outcome.id, version: selectedForProject.outcome.currentVersion }); await refresh(); await open(selectedForProject.outcome.id); } catch (error) { console.error('[OutcomesPage] markOutcomeFinal failed:', error); setOperationNotice('标记最终版未完成，状态未改动；请重试。'); } finally { setMarkFinalBusy(false); } }}><Check size={14} />标记最终版</button></div></header>
         {['word', 'ppt', 'spreadsheet', 'pdf'].includes(selectedForProject.outcome.kind) && <section className="outcomes-external-editor-actions" aria-label="Metis Office"><div><strong>Metis Office 原生编辑</strong></div>{externalEditorSession?.outcomeId === selectedForProject.outcome.id ? <div><button type="button" onClick={() => void syncFromGenoffice()} disabled={externalEditorBusy}>同步回 METIS</button><button type="button" onClick={() => void closeGenofficeEditor()} disabled={externalEditorBusy}>放弃会话</button><span>当前文件：{externalEditorSession.fileName}</span></div> : <><button type="button" onClick={() => void openInGenoffice()} disabled={externalEditorBusy} title="在独立窗口中用原生 Ribbon 编辑当前文件"><FileSpreadsheet size={14} />Metis Office</button></>}</section>}
           {nativeEmbeddedActive && <div ref={embeddedStageRef} className="genoffice-embedded-stage" aria-label="Metis Office 原生编辑区"><span>Metis Office 原生编辑器正在此区域运行；在该画布中直接编辑，保存后回到右侧“同步回 METIS”。</span></div>}
           {!nativeEmbeddedActive && editorDocument.type === 'word' && <WordEditor key={`${selectedForProject.outcome.id}-word-${selectedForProject.version.version}`} projectId={projectId} outcomeId={selectedForProject.outcome.id} hasUnsavedChanges={hasUnsavedChanges} document={editorDocument} onChange={setEditorDocument} onSave={(next, note) => save(next, note)} onNotice={setOperationNotice} onSelectionChange={updateAssistantSelection} onAssistantApplied={applyAssistantVersion} onConversationChanged={() => setAssistantHistoryRevision((revision) => revision + 1)} />}
           {editorDocument.type === 'word' && <OutcomeWordFormattingPanel document={editorDocument} openRequest={formattingOpenRequest} hideTrigger onApply={(next, note) => { setEditorDocument(next); setOperationNotice(note); }} />}
          {!nativeEmbeddedActive && editorDocument.type === 'ppt' && <PptStudioEditor key={`${selectedForProject.outcome.id}-ppt-${selectedForProject.version.version}`} projectId={projectId} outcomeId={selectedForProject.outcome.id} baseVersion={selectedForProject.version.version} hasUnsavedChanges={hasUnsavedChanges} document={editorDocument} initialPageId={assistantSelection?.kind === 'ppt' ? assistantSelection.pageId : undefined} initialSelectedElementId={assistantSelection?.kind === 'ppt' ? assistantSelection.elementId : undefined} onChange={setEditorDocument} onSave={(next) => void save(next, '保存 PPT Grid 布局')} onNotice={setOperationNotice} onGenerationApplied={async (applied) => { await applyAssistantVersion(applied as unknown as AssistantApplied); setOperationNotice('PPT Generation Skill 已生成并保存为新版本；可在版本面板查看或恢复。'); }} onGenerationConflict={async () => { await open(selectedForProject.outcome.id); setOperationNotice('PPT 生成因版本已更新而未提交；已刷新到当前版本。'); }} onSelectionChange={updateAssistantSelection} />}
         {(!nativeEmbeddedActive) && (editorDocument.type === 'other' || editorDocument.type === 'spreadsheet' || editorDocument.type === 'pdf') && <MediaEditor projectId={projectId} outcomeId={selectedForProject.outcome.id} kind={selectedForProject.outcome.kind} hasUnsavedChanges={hasUnsavedChanges} document={editorDocument} onChange={setEditorDocument} onSave={(next, note, actor = 'human') => void save(next, note, actor)} />}
        <VersionPanel versions={versions} activeVersion={selectedForProject.version.version} onOpen={(version) => void open(selectedForProject.outcome.id, version.version)} onRestore={(version) => void restoreVersion(version)} />
      </>}
    </main>
    <SplitHandle
      label="拖动调整助手面板宽度"
      testId="outcomes-split-assistant"
      onDrag={handleAssistantDrag}
      onKeyDelta={(delta) => setAssistantWidth((current) => Math.min(520, Math.max(260, current - delta)))}
    />
    <OutcomeAssistant key={`${projectId}-${selectedForProject?.outcome.id ?? 'none'}`} projectId={projectId} projectName={project?.title ?? projectId} detail={selectedForProject} selection={assistantSelection} hasUnsavedChanges={hasUnsavedChanges} historyRevision={assistantHistoryRevision} onOpenOutcomeVersion={openOutcomeSource} onLocate={locateSource} onApplied={(applied) => void applyAssistantVersion(applied)} onConversationChanged={() => setAssistantHistoryRevision((revision) => revision + 1)} />
    {createOpen && <CreateDialog categories={categories} close={() => setCreateOpen(false)} create={create} busy={createBusy} />}
    {submissionOpen && selectedForProject && <SubmissionDialog
      close={() => setSubmissionOpen(false)}
      onCreated={() => { setSubmissionOpen(false); setOperationNotice('投稿事务已创建；已转到投稿页。'); onNavigateToSubmissions?.(); }}
      projectId={projectId}
      outcomeId={selectedForProject.outcome.id}
      outcomeTitle={selectedForProject.outcome.title}
      outcomeVersion={selectedForProject.version.version}
    />}
    {trashOpen && <OutcomeTrashDialog items={trashItems} now={trashOpenedAt} confirmId={trashConfirmId} setConfirmId={setTrashConfirmId} close={() => setTrashOpen(false)} onRestore={(id) => void restoreTrashOutcome(id)} onDeleteForever={(id) => void deleteTrashOutcomeForever(id)} />}
    {categoryPrompt && <PromptDialog title={categoryPrompt.mode === 'rename' ? '重命名分类' : '新建分类'} fieldLabel="分类名称" confirmLabel={categoryPrompt.mode === 'rename' ? '重命名' : '创建'} initialValue={categoryPrompt.mode === 'rename' ? categoryPrompt.initialName : ''} close={() => setCategoryPrompt(null)} submit={(value) => void submitCategoryPrompt(value)} />}
  </div>;
}

function OutcomeCategorySection({ category, outcomes, activeId, onOpen, onMove, onTrash, onRename, onDelete }: { category: OutcomeCategory | null; outcomes: OutcomeSummary[]; activeId: string | undefined; onOpen: (id: string) => void; onMove: (id: string, categoryId: string | null) => void; onTrash: (item: OutcomeSummary) => void; onRename?: () => void; onDelete?: () => void }) {
  const categoryId = category?.id ?? null;
  // 刘总规格：拖拽归类必须给出落点高亮；dragOver 高频触发，仅在状态变化时 setState。
  const [dropActive, setDropActive] = useState(false);
  return <section className={`outcomes-category${dropActive ? ' drop-target' : ''}`} onDragOver={(event) => { event.preventDefault(); event.dataTransfer.dropEffect = 'move'; if (!dropActive) setDropActive(true); }} onDragLeave={(event) => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) setDropActive(false); }} onDrop={(event) => { event.preventDefault(); setDropActive(false); const outcomeId = event.dataTransfer.getData('application/x-metis-outcome'); if (outcomeId) onMove(outcomeId, categoryId); }}><div className="outcomes-category-title"><span>{category?.name ?? '未分类'}</span>{category && <span className="outcomes-category-title__actions"><button type="button" onClick={() => void onRename?.()} title="重命名分类" aria-label={`重命名${category.name}`}><Pencil size={13} /></button><button className="outcomes-category-title__delete" type="button" onClick={() => void onDelete?.()} title="删除分类（成果移回未分类）" aria-label={`删除分类${category.name}`}><Trash2 size={13} /></button></span>}</div>{outcomes.map((item) => <OutcomeRow key={item.id} item={item} active={activeId === item.id} open={onOpen} trash={onTrash} />)}</section>;
}
function OutcomeRow({ item, active, open, trash }: { item: OutcomeSummary; active: boolean; open: (id: string) => void; trash: (item: OutcomeSummary) => void }) {
  // 刘总反馈：原来只有一个菜单项的「···」菜单让用户困惑，简化为悬停可见的直接回收站按钮。
  return <div className={`outcome-tree-item ${active ? 'selected' : ''}`} role="button" tabIndex={0} draggable onDragStart={(event) => { event.dataTransfer.effectAllowed = 'move'; event.dataTransfer.setData('application/x-metis-outcome', item.id); }} onClick={() => open(item.id)} onKeyDown={(event) => { if (event.key === 'Enter' || event.key === ' ') { event.preventDefault(); open(item.id); } }} title="拖动到分类以整理成果"><GripVertical size={13} className="outcome-tree-item__grip" />{kindIcon(item.kind)}<span>{item.title}</span><small>v{item.currentVersion}</small><span className="outcome-tree-item__actions" onClick={(event) => event.stopPropagation()} onKeyDown={(event) => event.stopPropagation()}><button className="outcome-tree-item__trash" type="button" title="移入回收站" aria-label={`将「${item.title}」移入回收站`} onClick={() => trash(item)}><Trash2 size={13} /></button></span></div>;
}
function OutcomeTrashDialog({ items, now, confirmId, setConfirmId, close, onRestore, onDeleteForever }: { items: OutcomeTrashEntry[]; now: number; confirmId: string | null; setConfirmId: (id: string | null) => void; close: () => void; onRestore: (outcomeId: string) => void; onDeleteForever: (outcomeId: string) => void }) {
  const remainingDays = (expiresAt: number) => Math.max(0, Math.ceil((expiresAt - now) / (24 * 60 * 60 * 1000)));
  return <div className="outcomes-modal-backdrop" role="presentation"><div className="outcomes-modal outcomes-trash-modal" role="dialog" aria-modal="true" aria-label="成果回收站"><header><strong>成果回收站</strong><button type="button" onClick={close} aria-label="关闭"><X size={16} /></button></header><p className="outcomes-trash-modal__hint">删除的成果在此保留 7 天，到期自动彻底删除（含源文件），彻底删除后不可恢复。</p>{items.length === 0 ? <p className="outcomes-trash-modal__empty">回收站是空的。</p> : <ul className="outcomes-trash-list">{items.map((entry) => <li key={entry.outcome.id} className="outcomes-trash-item"><div className="outcomes-trash-item__meta">{kindIcon(entry.outcome.kind)}<div><strong>{entry.outcome.title}</strong><small>删除于 {new Date(entry.deletedAt).toLocaleString()} · 剩余 {remainingDays(entry.expiresAt)} 天</small></div></div><div className="outcomes-trash-item__actions">{confirmId === entry.outcome.id ? <><span className="outcomes-trash-item__warn">不可恢复</span><button className="danger" type="button" onClick={() => onDeleteForever(entry.outcome.id)}>确认彻底删除</button><button type="button" onClick={() => setConfirmId(null)}>取消</button></> : <><button type="button" onClick={() => onRestore(entry.outcome.id)}><RotateCcw size={13} />恢复</button><button type="button" onClick={() => setConfirmId(entry.outcome.id)}><Trash2 size={13} />彻底删除</button></>}</div></li>)}</ul>}</div></div>;
}
function CreateDialog({ categories, close, create, busy }: { categories: OutcomeCategory[]; close: () => void; create: (kind: OutcomeKind, title: string, categoryId: string | null) => void; busy: boolean }) {
  const [kind, setKind] = useState<OutcomeKind>('word'); const [title, setTitle] = useState(''); const [categoryId, setCategoryId] = useState('');
  return <div className="outcomes-modal-backdrop" role="presentation"><form className="outcomes-modal" onSubmit={(event) => { event.preventDefault(); create(kind, title, categoryId || null); }}><header><strong>新建成果</strong><button type="button" onClick={close} aria-label="关闭" disabled={busy}><X size={16} /></button></header><label>成果名称<input autoFocus value={title} onChange={(event) => setTitle(event.target.value)} disabled={busy} /></label><label>成果类型<select value={kind} onChange={(event) => setKind(event.target.value as OutcomeKind)} disabled={busy}><option value="word">Word 论文 / 报告</option><option value="ppt">PPT 演示文稿</option><option value="spreadsheet">Excel 工作簿</option><option value="pdf">PDF</option><option value="image">图片</option><option value="chart">图表</option><option value="other">其他正式交付物</option></select></label><label>分类<select value={categoryId} onChange={(event) => setCategoryId(event.target.value)} disabled={busy}><option value="">未分类</option>{categories.map((category) => <option key={category.id} value={category.id}>{category.name}</option>)}</select></label><footer><button type="button" onClick={close} disabled={busy}>取消</button><button className="primary" disabled={busy || !title.trim()}>{busy ? '创建中…' : '创建'}</button></footer></form></div>;
}
/** 准备投稿：以当前成果版本创建 Submission Case（匹配期刊 / 指定期刊）。 */
function SubmissionDialog({ close, onCreated, projectId, outcomeId, outcomeTitle, outcomeVersion }: {
  close: () => void; onCreated: () => void; projectId: string; outcomeId: string; outcomeTitle: string; outcomeVersion: number;
}) {
  const [mode, setMode] = useState<'specify' | 'match'>('specify');
  const [journal, setJournal] = useState('');
  const [articleType, setArticleType] = useState('');
  const [error, setError] = useState('');
  const [busy, setBusy] = useState(false);
  return <div className="outcomes-modal-backdrop" role="presentation"><form className="outcomes-modal" role="dialog" aria-modal="true" aria-label="准备投稿" onSubmit={(event) => {
    event.preventDefault();
    if (!window.metis?.createSubmissionCase || busy) return;
    if (mode === 'specify' && !journal.trim()) return;
    setBusy(true);
    void window.metis.createSubmissionCase({
      projectId,
      title: outcomeTitle,
      sourceOutcomeId: outcomeId,
      sourceOutcomeVersion: outcomeVersion,
      targetJournalName: mode === 'specify' ? journal.trim() : '',
      articleType: (articleType || null) as null | 'research_article' | 'review' | 'short_communication' | 'letter' | 'case_report' | 'conference_paper' | 'thesis_chapter' | 'other',
      initialStatus: mode === 'specify' ? 'JOURNAL_SELECTED' : 'TARGETING',
    }).then((result) => {
      setBusy(false);
      if (result && 'ok' in result && result.ok === false && result.code === 'duplicate_active') {
        setError(`该成果已有进行中的投稿（${result.activeJournal || '待选刊'}）。同一篇稿件同时投多个期刊存在一稿多投风险；请先等拒稿/撤稿，或确认后再继续。`);
        return;
      }
      // createCase resolves with { series, submissionCase } (no `ok` flag);
      // null means the handler rejected the request.
      if (result && 'submissionCase' in result) onCreated();
      else setError('创建投稿事务失败，请稍后重试。');
    });
  }}><header><strong>准备投稿</strong><button type="button" onClick={close} aria-label="关闭"><X size={16} /></button></header>
    <label>当前成果<input value={`${outcomeTitle}（v${outcomeVersion}）`} readOnly /></label>
    <fieldset className="submissions-create-mode">
      <label><input type="radio" name="outcome-submission-mode" checked={mode === 'specify'} onChange={() => setMode('specify')} />我已经有目标期刊</label>
      {mode === 'specify' && <>
        <input className="settings-input" value={journal} placeholder="输入目标期刊名称" aria-label="目标期刊名称" autoFocus onChange={(event) => setJournal(event.target.value)} />
        <label>文章类型<select value={articleType} aria-label="文章类型" onChange={(event) => setArticleType(event.target.value)}>
          <option value="">未指定</option>
          <option value="research_article">研究论文</option><option value="review">综述</option>
          <option value="short_communication">短文</option><option value="letter">快报</option>
          <option value="case_report">案例报告</option><option value="conference_paper">会议论文</option>
          <option value="thesis_chapter">学位论文章节</option><option value="other">其他</option>
        </select></label>
      </>}
      <label><input type="radio" name="outcome-submission-mode" checked={mode === 'match'} onChange={() => setMode('match')} />帮我匹配期刊</label>
      {mode === 'match' && <p style={{ margin: 0, fontSize: 12, color: 'var(--text-tertiary)' }}>创建后投稿状态为「选刊中」，期刊匹配将在投稿页继续。</p>}
    </fieldset>
    {error && <p role="alert" style={{ margin: '0 0 10px', fontSize: 12, color: 'var(--status-error)' }}>{error}</p>}
    <footer><button type="button" onClick={close}>取消</button><button className="primary" disabled={busy || (mode === 'specify' && !journal.trim())}>创建投稿事务</button></footer>
  </form></div>;
}

function PromptDialog({ title, fieldLabel, confirmLabel, initialValue = '', close, submit }: { title: string; fieldLabel: string; confirmLabel: string; initialValue?: string; close: () => void; submit: (value: string) => void }) {  const [value, setValue] = useState(initialValue);
  return <div className="outcomes-modal-backdrop" role="presentation"><form className="outcomes-modal" role="dialog" aria-modal="true" aria-label={title} onSubmit={(event) => { event.preventDefault(); if (!value.trim()) return; submit(value.trim()); }}><header><strong>{title}</strong><button type="button" onClick={close} aria-label="关闭"><X size={16} /></button></header><label>{fieldLabel}<input autoFocus value={value} onFocus={(event) => event.currentTarget.select()} onChange={(event) => setValue(event.target.value)} /></label><footer><button type="button" onClick={close}>取消</button><button className="primary" disabled={!value.trim()}>{confirmLabel}</button></footer></form></div>;
}

type WordEditorProps = { projectId: string; outcomeId: string; hasUnsavedChanges: boolean; document: WordDocument; onChange: (value: WordDocument) => void; onSave: (value: WordDocument, note: string) => Promise<boolean> | void; onSelectionChange: (selection: AssistantSelection) => void; onAssistantApplied: (value: AssistantApplied | undefined) => Promise<void>; onConversationChanged: () => void; onNotice?: (notice: string) => void };

function WordEditor(props: WordEditorProps) {
  const [activeBlockId, setActiveBlockId] = useState(props.document.blocks[0]?.id ?? '');
  const [history, setHistory] = useState({ entries: [props.document], index: 0 });
  const [citationRequest, setCitationRequest] = useState(0);
  const resolvedActiveBlockId = props.document.blocks.some((block) => block.id === activeBlockId) ? activeBlockId : props.document.blocks[0]?.id ?? '';
  const active = props.document.blocks.find((block) => block.id === resolvedActiveBlockId) ?? props.document.blocks[0];
  const activeKind = active?.kind === 'heading' || active?.kind === 'paragraph' ? active.kind : undefined;
  const update = (next: WordDocument) => {
    if (JSON.stringify(next) === JSON.stringify(props.document)) return;
    const entries = [...history.entries.slice(0, history.index + 1), next].slice(-80);
    setHistory({ entries, index: entries.length - 1 });
    props.onChange(next);
  };
  const restore = (direction: -1 | 1) => {
    const index = Math.max(0, Math.min(history.entries.length - 1, history.index + direction));
    if (index === history.index) return;
    setHistory({ ...history, index });
    props.onChange(history.entries[index]!);
  };
  return <>
     <OfficeWordRibbon document={props.document} activeBlockId={active?.id ?? ''} activeStyle={active?.style ?? {}} activeKind={activeKind} activeLevel={active?.level} historyState={{ index: history.index, length: history.entries.length }} onChange={update} onSave={() => props.onSave(props.document, '保存编辑')} onHistory={restore} onCitation={() => setCitationRequest((value) => value + 1)} onNotice={(notice) => props.onNotice?.(notice)} />
     <LegacyWordEditor {...props} onChange={update} citationRequest={citationRequest} onSelectionChange={(selection) => { if (selection?.kind === 'word') setActiveBlockId(selection.blockId); props.onSelectionChange(selection); }} />
  </>;
}

function LegacyWordEditor({ projectId, outcomeId, hasUnsavedChanges, document, onChange, onSave, onSelectionChange, onAssistantApplied, onConversationChanged, onNotice, citationRequest }: WordEditorProps & { citationRequest: number }) {
  const doc = document;
  useLayoutEffect(() => {
    const toolbars = Array.from(window.document.querySelectorAll<HTMLElement>('.word-studio > .word-toolbar'));
    toolbars.forEach((toolbar) => {
      toolbar.hidden = true;
      toolbar.setAttribute('aria-hidden', 'true');
      toolbar.querySelectorAll<HTMLElement>('[aria-label]').forEach((control) => control.removeAttribute('aria-label'));
      toolbar.querySelectorAll<HTMLElement>('[title]').forEach((control) => control.removeAttribute('title'));
    });
  }, []);
  const [activeBlockId, setActiveBlockId] = useState(document.blocks[0]?.id ?? '');
  const [caret, setCaret] = useState<{ id: string; offset: number } | null>(null);
  const [citation, setCitation] = useState('');
  const [citationOpen, setCitationOpen] = useState(false);
  useEffect(() => {
    if (!citationOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setCitationOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [citationOpen]);
  useEffect(() => {
    if (citationRequest <= 0) return undefined;
    const timer = window.setTimeout(() => setCitationOpen(true), 0);
    return () => window.clearTimeout(timer);
  }, [citationRequest]);
  const [localSelection, setLocalSelection] = useState<Extract<AssistantSelection, { kind: 'word' }>>();
  const [crossSelection, setCrossSelection] = useState<Extract<AssistantSelection, { kind: 'word' }>>();
  const crossSelectionRef = useRef<Extract<AssistantSelection, { kind: 'word' }> | undefined>(undefined);
  crossSelectionRef.current = crossSelection;
  const localSelectionRef = useRef<Extract<AssistantSelection, { kind: 'word' }> | undefined>(undefined);
  localSelectionRef.current = localSelection;
  const [localAnchor, setLocalAnchor] = useState<{ left: number; top: number; bottom?: number }>({ left: 16, top: 16 });
  const historyRef = useRef({ entries: [document], index: 0 });
  const [historyState, setHistoryState] = useState({ index: 0, length: 1 });
  const update = (next: WordDocument) => {
    if (JSON.stringify(next) === JSON.stringify(doc)) return;
    const current = historyRef.current;
    const entries = [...current.entries.slice(0, current.index + 1), next].slice(-80);
    historyRef.current = { entries, index: entries.length - 1 };
    setHistoryState({ index: entries.length - 1, length: entries.length });
    onChange(next);
  };
  const restoreHistory = (direction: -1 | 1) => {
    const current = historyRef.current;
    const index = Math.max(0, Math.min(current.entries.length - 1, current.index + direction));
    if (index === current.index) return;
    historyRef.current = { ...current, index };
    setHistoryState({ index, length: current.entries.length });
    onChange(current.entries[index]!);
  };
  const updateText = (id: string, text: string) => update({ ...doc, blocks: doc.blocks.map((block) => block.id === id ? { ...block, text } : block) });
  const splitParagraphAtCaret = (event: React.KeyboardEvent<HTMLElement>, block: WordBlock) => {
    if (block.kind !== 'paragraph' && block.kind !== 'heading' && block.kind !== 'figure_caption' && block.kind !== 'table_caption') return;
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!range || !event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) return;
    const before = range.cloneRange();
    before.selectNodeContents(event.currentTarget);
    before.setEnd(range.startContainer, range.startOffset);
    const start = Math.max(0, Math.min((block.text ?? '').length, before.toString().length));
    const selectedLength = selection?.toString().length ?? 0;
    const sourceText = block.text ?? '';
    const left = sourceText.slice(0, start);
    const right = sourceText.slice(Math.min(sourceText.length, start + selectedLength));
    let index = doc.blocks.length + 1;
    let id = `paragraph-${index}`;
    while (doc.blocks.some((candidate) => candidate.id === id)) id = `paragraph-${++index}`;
    const nextBlock: WordBlock = { ...block, id, text: right };
    const blocks = doc.blocks.flatMap((candidate) => candidate.id === block.id ? [{ ...candidate, text: left }, nextBlock] : [candidate]);
    update({ ...doc, blocks });
  };
  const updateActive = (patch: Record<string, unknown>) => update({ ...doc, blocks: doc.blocks.map((block) => block.id === activeBlockId ? { ...block, style: { ...block.style, ...patch } } : block) });
  const setBlockKind = (kind: 'paragraph' | 'heading', level?: number) => update({ ...doc, blocks: doc.blocks.map((block) => block.id === activeBlockId ? { ...block, kind, ...(level ? { level } : {}) } : block) });
  const updateTableCell = (blockId: string, rowIndex: number, cellIndex: number, value: string) => update({ ...doc, blocks: doc.blocks.map((block) => {
    if (block.id !== blockId || block.kind !== 'table') return block;
    return { ...block, rows: (block.rows ?? []).map((row, currentRow) => currentRow === rowIndex ? row.map((cell, currentCell) => currentCell === cellIndex ? value : cell) : row) };
  }) });
  const nextBlockId = (prefix: string) => { let index = doc.blocks.length + 1; let id = `${prefix}-${index}`; while (doc.blocks.some((block) => block.id === id)) { index += 1; id = `${prefix}-${index}`; } return id; };
  const capture = (event: React.SyntheticEvent<HTMLElement>) => {
    const targetBlockId = String(event.currentTarget.dataset.block ?? '');
    if (targetBlockId) setActiveBlockId(targetBlockId);
    const selection = window.getSelection();
    const range = selection?.rangeCount ? selection.getRangeAt(0) : null;
    if (!selection || !range) {
      // 没有 DOM range（jsdom 点击、点击非文本区）时仍必须上报激活块，
      // 否则局部 AI 请求会丢 blockId（2026-09-02 修复：回归点击即选中的契约）。
      setLocalSelection(undefined); setCrossSelection(undefined);
      if (targetBlockId) onSelectionChange({ kind: 'word', blockId: targetBlockId, text: '' });
      return;
    }
    const nodeToBlock = (node: Node | null): HTMLElement | null => {
      const element = node ? (node.nodeType === 1 ? node as Element : node.parentElement) : null;
      return element?.closest<HTMLElement>('[data-block]') ?? null;
    };
    const startEl = nodeToBlock(range.startContainer);
    const endEl = nodeToBlock(range.endContainer);
    const blockOf = (element: HTMLElement | null) => doc.blocks.find((item) => item.id === element?.dataset.block);
    if (!startEl || !endEl) return;
    const anchorRect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : startEl.getBoundingClientRect();
    const showPopover = (next: Extract<AssistantSelection, { kind: 'word' }>) => {
      const blockRect = startEl.getBoundingClientRect();
      const left = Math.min(Math.max(12, (anchorRect.left || blockRect.left) + 8), Math.max(12, window.innerWidth - 326));
      const top = Math.max(12, (anchorRect.top || blockRect.top) - 10);
      setLocalAnchor({ left, top, bottom: anchorRect.bottom || blockRect.bottom });
      setLocalSelection(next);
    };
    if (startEl === endEl) {
      const block = blockOf(startEl);
      if (!block) return;
      const contentLength = (block.text ?? '').length;
      if (!startEl.contains(range.startContainer) || !startEl.contains(range.endContainer)) {
        setLocalSelection(undefined); setCrossSelection(undefined);
        onSelectionChange({ kind: 'word', blockId: block.id, text: '' });
        return;
      }
      const before = range.cloneRange();
      before.selectNodeContents(startEl);
      before.setEnd(range.startContainer, range.startOffset);
      const selectedText = selection.toString() ?? '';
      const start = Math.min(contentLength, Math.max(0, before.toString().length));
      const end = Math.min(contentLength, start + selectedText.length);
      setCaret({ id: block.id, offset: start });
      const nextSelection: Extract<AssistantSelection, { kind: 'word' }> = { kind: 'word', blockId: block.id, text: selectedText, start, end };
      onSelectionChange(nextSelection);
      setCrossSelection(undefined);
      if (!selectedText || end <= start) { setLocalSelection(undefined); return; }
      showPopover(nextSelection);
      return;
    }
    // 跨段/跨页选区（2026-09-01 刘总要求）：浮窗照常弹出；发送时自动把所选
    // 段落合并为基线版本再交给局部 AI。AI 应用的锚定信息放在 cross 字段。
    const startBlock = blockOf(startEl);
    const endBlock = blockOf(endEl);
    if (!startBlock || !endBlock) return;
    const beforeStart = range.cloneRange();
    beforeStart.selectNodeContents(startEl);
    beforeStart.setEnd(range.startContainer, range.startOffset);
    const afterEnd = range.cloneRange();
    afterEnd.selectNodeContents(endEl);
    afterEnd.setStart(range.endContainer, range.endOffset);
    const startOffset = Math.min((startBlock.text ?? '').length, Math.max(0, beforeStart.toString().length));
    const endOffset = Math.max(0, (endBlock.text ?? '').length - Math.min((endBlock.text ?? '').length, afterEnd.toString().length));
    const selectedText = selection.toString() ?? '';
    if (!selectedText.trim()) { setLocalSelection(undefined); setCrossSelection(undefined); return; }
    const crossSelection: Extract<AssistantSelection, { kind: 'word' }> = {
      kind: 'word', blockId: startBlock.id, text: selectedText,
      start: startOffset, end: startOffset + selectedText.length,
      cross: { endBlockId: endBlock.id, endOffset },
    };
    onSelectionChange(crossSelection);
    setCrossSelection(crossSelection);
    showPopover(crossSelection);
  };
  const captureTableCell = (event: React.SyntheticEvent<HTMLElement>, blockId: string, rowIndex: number, cellIndex: number) => { setActiveBlockId(blockId); const block = doc.blocks.find((item) => item.id === blockId); const cellText = block?.rows?.[rowIndex]?.[cellIndex] ?? ''; const selection = window.getSelection(); const range = selection?.rangeCount ? selection.getRangeAt(0) : null; if (!range || !event.currentTarget.contains(range.startContainer) || !event.currentTarget.contains(range.endContainer)) { setLocalSelection(undefined); onSelectionChange({ kind: 'word', blockId, text: '' }); return; } const before = range.cloneRange(); before.selectNodeContents(event.currentTarget); before.setEnd(range.startContainer, range.startOffset); const selectedText = selection?.toString() ?? ''; const start = Math.min(cellText.length, Math.max(0, before.toString().length)); const end = Math.min(cellText.length, start + selectedText.length); const nextSelection = { kind: 'word' as const, blockId, text: selectedText, start, end, row: rowIndex, column: cellIndex }; onSelectionChange(nextSelection); if (!selectedText || end <= start) { setLocalSelection(undefined); return; } const rangeRect = typeof range.getBoundingClientRect === 'function' ? range.getBoundingClientRect() : event.currentTarget.getBoundingClientRect(); const cellRect = event.currentTarget.getBoundingClientRect(); const left = Math.min(Math.max(12, (rangeRect.left || cellRect.left) + 8), Math.max(12, window.innerWidth - 326)); const top = Math.max(12, (rangeRect.top || cellRect.top) - 10); setLocalAnchor({ left, top, bottom: rangeRect.bottom || cellRect.bottom }); setLocalSelection(nextSelection); };
  const insertCitation = () => { if (!caret || !citation.trim()) return; const refs = doc.blocks.filter((block) => block.id.startsWith('reference-')); const number = refs.length + 1; const blocks = doc.blocks.map((block) => block.id === caret.id ? { ...block, text: `${(block.text ?? '').slice(0, caret.offset)}${superNumber(number)}${(block.text ?? '').slice(caret.offset)}` } : block); if (!blocks.some((block) => block.id === 'references-heading')) blocks.push({ id: 'references-heading', kind: 'heading', level: 1, text: '参考文献' }); blocks.push({ id: nextBlockId('reference'), kind: 'paragraph', text: `[${number}] ${citation.trim()}`, style: { reference: true } }); update({ ...doc, blocks }); setCitation(''); setCitationOpen(false); };
  const active = doc.blocks.find((block) => block.id === activeBlockId); const activeStyle = active?.style ?? {};
  const displayStyle = (style: Record<string, unknown> | undefined) => {
    const value = style ?? {}; const fontSize = typeof value.fontSizePt === 'number' ? value.fontSizePt : typeof value.fontSize === 'number' ? value.fontSize : undefined; const indent = typeof value.firstLineIndentChars === 'number' ? `${value.firstLineIndentChars}em` : typeof value.firstLineIndent === 'number' ? `${value.firstLineIndent}pt` : undefined;
    return { fontWeight: value.bold === true ? 700 : undefined, fontStyle: value.italic === true ? 'italic' : undefined, textDecoration: value.underline === true ? 'underline' : undefined, textAlign: typeof value.align === 'string' ? value.align as 'left' | 'center' | 'right' | 'justify' : undefined, fontFamily: typeof value.fontFamily === 'string' ? value.fontFamily : undefined, fontSize: fontSize ? `${fontSize}pt` : undefined, color: typeof value.color === 'string' ? value.color : undefined, lineHeight: typeof value.lineSpacing === 'number' ? value.lineSpacing : undefined, textIndent: indent, marginTop: typeof value.spaceBeforePt === 'number' ? `${value.spaceBeforePt}pt` : typeof value.spaceBefore === 'number' ? `${value.spaceBefore}pt` : undefined, marginBottom: typeof value.spaceAfterPt === 'number' ? `${value.spaceAfterPt}pt` : typeof value.spaceAfter === 'number' ? `${value.spaceAfter}pt` : undefined };
  };
  const finitePageNumber = (value: unknown): number | undefined => typeof value === 'number' && Number.isFinite(value) ? value : undefined;
  const pageValue = doc.page as Record<string, unknown>;
  const pageWidthTwips = finitePageNumber(pageValue.width) ?? (pageValue.paper === 'Letter' ? 12240 : 11906);
  const pageHeightTwips = finitePageNumber(pageValue.height) ?? (pageValue.paper === 'Letter' ? 15840 : 16838);
  const pageDimension = (twips: number) => `${Math.round(twips / 1440 * 96)}px`;
  const marginDimension = (cmKey: string, pointKey: string, fallback: number) => {
    const centimeters = finitePageNumber(pageValue[cmKey]);
    const points = centimeters !== undefined ? centimeters * 72 / 2.54 : finitePageNumber(pageValue[pointKey]) ?? fallback;
    return `${Math.max(0, Math.round(points / 72 * 96))}px`;
  };
  const wordPageStyle = {
    '--word-page-width': pageDimension(pageWidthTwips),
    '--word-page-height': pageDimension(pageHeightTwips),
    '--word-page-margin-top': marginDimension('marginTopCm', 'marginTop', 72),
    '--word-page-margin-right': marginDimension('marginRightCm', 'marginRight', 72),
    '--word-page-margin-bottom': marginDimension('marginBottomCm', 'marginBottom', 72),
    '--word-page-margin-left': marginDimension('marginLeftCm', 'marginLeft', 72),
  } as React.CSSProperties;
  const pageNumber = pageValue.pageNumber === true;
  // ── 实测分页（2026-08-24 刘总反馈：长文档溢出到页面外、没有分页）──
  // 隐藏测量页渲染全部内容块，按真实高度把块切分到多个 A4 页面；
  // 单个超高块（如整页大表格）独占一页，该页自然增高，不再溢出到空白处。
  // 测量依赖 ResizeObserver 跟踪尺寸变化；无 ResizeObserver 的环境（如 jsdom）
  // 不渲染测量页，保持单页渲染的原有行为。
  type WordBlock = WordDocument['blocks'][number];
  const measureRef = useRef<HTMLElement>(null);
  const [measureRevision, setMeasureRevision] = useState(0);
  const [pageStarts, setPageStarts] = useState<number[]>([0]);
  const pageHeightPx = Math.round(pageHeightTwips / 1440 * 96);
  const marginNumber = (cmKey: string, pointKey: string, fallback: number) => {
    const centimeters = finitePageNumber(pageValue[cmKey]);
    const points = centimeters !== undefined ? centimeters * 72 / 2.54 : finitePageNumber(pageValue[pointKey]) ?? fallback;
    return Math.max(0, Math.round(points / 72 * 96));
  };
  const marginTopPx = marginNumber('marginTopCm', 'marginTop', 72);
  const marginBottomPx = marginNumber('marginBottomCm', 'marginBottom', 72);
  const headerReserve = doc.header ? 40 : 0;
  const footerReserve = doc.footer || pageNumber ? 48 : 0;
  const pageCapacity = Math.max(120, pageHeightPx - marginTopPx - marginBottomPx - headerReserve - footerReserve);
  useLayoutEffect(() => {
    const measure = measureRef.current;
    const body = measure?.querySelector('.word-page__body');
    if (!body) return;
    const heights = Array.from(body.children).map((element) => {
      const style = window.getComputedStyle(element);
      return (element as HTMLElement).offsetHeight + (parseFloat(style.marginTop) || 0) + (parseFloat(style.marginBottom) || 0);
    });
    const starts = [0];
    let used = 0;
    heights.forEach((height, index) => {
      if (index === 0) { used = height; return; }
      if (used > 0 && used + height > pageCapacity) { starts.push(index); used = height; } else { used += height; }
    });
    setPageStarts((prev) => prev.length === starts.length && prev.every((value, index) => value === starts[index]) ? prev : starts);
  }, [doc.blocks, pageCapacity, measureRevision]);
  useLayoutEffect(() => {
    const measure = measureRef.current;
    if (!measure || typeof ResizeObserver === 'undefined') return undefined;
    const observer = new ResizeObserver(() => setMeasureRevision((value) => value + 1));
    observer.observe(measure);
    return () => observer.disconnect();
  }, []);
  // 自由跨段编辑（2026-09-01 刘总要求）：正文区是单一编辑宿主，段落不再各自
  // 为独立编辑器——原生选区可跨段选中/删除。输入后以 DOM 为准回写模型：
  // 改写对应块文本，浏览器原生删并/删空段落时同步增删模型块。
  const reconcileBodyInput = (event: React.FormEvent<HTMLElement>) => {
    const body = event.currentTarget;
    const nodes = Array.from(body.querySelectorAll<HTMLElement>('[data-block]'));
    const domIds = new Set(nodes.map((node) => node.dataset.block ?? ''));
    const textual = new Set(['paragraph', 'heading', 'figure_caption', 'table_caption']);
    let changed = false;
    const nextBlocks = doc.blocks.flatMap((block) => {
      if (!textual.has(block.kind)) return [block];
      if (!domIds.has(block.id)) { changed = true; return []; }
      const node = nodes.find((candidate) => candidate.dataset.block === block.id);
      const text = node?.textContent ?? '';
      if (text === block.text) return [block];
      changed = true;
      return [{ ...block, text }];
    });
    if (!changed) return;
    update({ ...doc, blocks: nextBlocks });
  };
  // 粘贴统一降为纯文本（多段落粘贴的自动分段下一版再补）；回车仍可分段。
  const handleBodyPaste = (event: React.ClipboardEvent<HTMLElement>) => {
    const text = event.clipboardData.getData('text/plain');
    if (!text) return;
    event.preventDefault();
    const flattened = text.replace(/\r\n?/gu, '\n').replace(/\n+/gu, ' ').replace(/[^\r\n 	]{2,}/gu, ' ').trim();
    window.document.execCommand('insertText', false, flattened);
  };
  // 跨段局部 AI 的发送前准备（2026-09-01 刘总要求）：把所选段落按选区边界
  // 合并为一个基线版本保存（版本面板可恢复），AI 在该单段上做局部修改。
  const prepareCrossSelection = async (): Promise<{ selection: Extract<AssistantSelection, { kind: 'word' }> } | { error: string }> => {
    const cross = crossSelectionRef.current;
    if (!cross?.cross) {
      // 单块/表格选区：直接使用打开浮窗时的真实选区。此前这里返回空 blockId
      // 的兜底对象，导致局部 AI 请求丢失选区（2026-09-02 修复）。
      const current = localSelectionRef.current;
      if (!current) return { error: '所选内容已变化，请重新选择后再发送。' };
      return { selection: current };
    }
    const startIndex = doc.blocks.findIndex((block) => block.id === cross.blockId);
    const crossTarget = cross.cross;
    const endIndex = doc.blocks.findIndex((block) => block.id === crossTarget.endBlockId);
    if (startIndex < 0 || endIndex < startIndex) return { error: '所选内容已变化，请重新选择后再发送。' };
    const startBlock = doc.blocks[startIndex]!;
    const endBlock = doc.blocks[endIndex]!;
    const startOffset = cross.start ?? 0;
    const endOffset = crossTarget.endOffset;
    const mergedText = (startBlock.text ?? '').slice(0, startOffset) + cross.text + (endBlock.text ?? '').slice(endOffset);
    const mergedBlock: WordBlock = { ...startBlock, text: mergedText };
    const next: WordDocument = { ...doc, blocks: [...doc.blocks.slice(0, startIndex), mergedBlock, ...doc.blocks.slice(endIndex + 1)] };
    onNotice?.('已合并所选段落并保存基线版本，正在发送局部 AI…');
    const saved = await onSave(next, '跨段局部编辑基线（合并所选段落）');
    if (saved === false) return { error: '基线版本保存未完成，AI 请求未发送；原文未被改动。' };
    setCrossSelection(undefined);
    return { selection: { kind: 'word', blockId: cross.blockId, text: cross.text, start: startOffset, end: startOffset + cross.text.length } };
  };
  const renderBlock = (block: WordBlock, measure: boolean) => {
    if (block.kind === 'table') {
      return <div key={`${measure ? 'm-' : ''}${block.id}`} contentEditable={false} style={{ display: 'flow-root' }}><table><tbody>{block.rows?.map((row, rowIndex) => <tr key={rowIndex}>{row.map((cell, cellIndex) => measure
        ? <td key={cellIndex}>{cell}</td>
        : <td key={cellIndex} contentEditable suppressContentEditableWarning onInput={(event) => { updateTableCell(block.id, rowIndex, cellIndex, event.currentTarget.textContent ?? ''); captureTableCell(event, block.id, rowIndex, cellIndex); }} onClick={(event) => captureTableCell(event, block.id, rowIndex, cellIndex)} onKeyUp={(event) => captureTableCell(event, block.id, rowIndex, cellIndex)}>{cell}</td>)}</tr>)}</tbody></table></div>;
    }
    if (block.kind === 'image') return <div key={`${measure ? 'm-' : ''}${block.id}`} contentEditable={false}><WordManagedImagePreview projectId={projectId} outcomeId={outcomeId} blockId={block.id} mediaId={block.imageRef} mediaType={block.mediaType} displayName={block.displayName} /></div>;
    if (measure) return <div key={`m-${block.id}`} className={`word-block ${block.kind} ${block.style?.list ? `word-block--${block.style.list}` : ''}`} style={displayStyle(block.style)}>{block.text}</div>;
     return <div key={block.id} data-block={block.id} className={`word-block ${block.kind} ${block.style?.list ? `word-block--${block.style.list}` : ''} ${block.id === activeBlockId ? 'is-active' : ''}`} style={displayStyle(block.style)} onClick={capture} onKeyDown={(event) => { if (event.key === 'Enter' && !event.shiftKey && !event.ctrlKey && !event.metaKey && !event.altKey) { event.preventDefault(); splitParagraphAtCaret(event, block); } }} onKeyUp={capture}>{block.text}</div>;
  };
  const pages = pageStarts.map((start, index) => doc.blocks.slice(start, pageStarts[index + 1] ?? doc.blocks.length));
  return <div className="word-studio"><div className="word-toolbar" aria-label="Word 编辑工具栏"><select aria-label="段落样式" value={active?.kind === 'heading' ? `h${active.level ?? 1}` : 'p'} onChange={(event) => { const value = event.target.value; if (value === 'p') setBlockKind('paragraph'); else setBlockKind('heading', Number(value.slice(1))); }}><option value="p">正文</option><option value="h1">一级标题</option><option value="h2">二级标题</option><option value="h3">三级标题</option></select><input aria-label="字体" value={typeof activeStyle.fontFamily === 'string' ? activeStyle.fontFamily : ''} placeholder="字体" onChange={(event) => updateActive({ fontFamily: event.target.value })} /><input aria-label="字号" type="number" min="6" max="96" value={typeof activeStyle.fontSizePt === 'number' ? activeStyle.fontSizePt : typeof activeStyle.fontSize === 'number' ? activeStyle.fontSize : 12} onChange={(event) => updateActive({ fontSizePt: Number(event.target.value) || 12 })} /><input aria-label="文字颜色" type="color" value={typeof activeStyle.color === 'string' && /^#[0-9a-f]{6}$/iu.test(activeStyle.color) ? activeStyle.color : '#17243A'} onChange={(event) => updateActive({ color: event.target.value })} /><button type="button" className={activeStyle.bold === true ? 'active' : ''} onClick={() => updateActive({ bold: activeStyle.bold !== true })} title="加粗"><strong>B</strong></button><button type="button" className={activeStyle.italic === true ? 'active' : ''} onClick={() => updateActive({ italic: activeStyle.italic !== true })} title="斜体"><em>I</em></button><button type="button" className={activeStyle.underline === true ? 'active' : ''} onClick={() => updateActive({ underline: activeStyle.underline !== true })} title="下划线"><Underline size={15} /></button><select aria-label="段落对齐" value={typeof activeStyle.align === 'string' ? activeStyle.align : 'left'} onChange={(event) => updateActive({ align: event.target.value })}><option value="left">左对齐</option><option value="center">居中</option><option value="right">右对齐</option><option value="justify">两端对齐</option></select><button type="button" onClick={() => updateActive({ list: activeStyle.list === 'bullet' ? undefined : 'bullet' })}>• 列表</button><button type="button" onClick={() => updateActive({ list: activeStyle.list === 'numbered' ? undefined : 'numbered' })}>1. 列表</button><button type="button" onClick={() => update({ ...doc, blocks: [...doc.blocks, { id: nextBlockId('table'), kind: 'table', rows: [['表头 1', '表头 2'], ['内容', '内容']] }] })} title="插入表格"><Table2 size={15} /></button><OutcomeWordFormattingPanel document={doc} onApply={(next) => update(next)} /><button type="button" onClick={() => restoreHistory(-1)} disabled={historyState.index === 0} title="撤销"><RotateCcw size={15} /></button><button type="button" onClick={() => restoreHistory(1)} disabled={historyState.index >= historyState.length - 1} title="重做"><RotateCcw size={15} className="word-toolbar__redo" /></button><span className="word-toolbar__spacer" /><button type="button" onClick={() => setCitationOpen(true)} disabled={!caret}>⁽¹⁾ 引文</button><button type="button" onClick={() => onSave(doc, '保存 Word 文档')}><Save size={15} />保存</button></div>{typeof ResizeObserver === 'undefined' ? null : <article ref={measureRef} className="word-page word-page--measure" style={wordPageStyle} aria-hidden="true"><div className="word-page__body">{doc.blocks.map((block) => renderBlock(block, true))}</div></article>}{<div className="word-pages-host" contentEditable suppressContentEditableWarning onInput={reconcileBodyInput} onPaste={handleBodyPaste} onMouseUp={capture}>{pages.map((pageBlocks, pageIndex) => <article key={pageIndex} className="word-page" style={wordPageStyle} aria-label={pageIndex === 0 ? 'Word 页面预览' : `Word 页面预览 第 ${pageIndex + 1} 页`}>{doc.header && <div className="word-page__header" contentEditable={false} data-testid={pageIndex === 0 ? 'word-page-header' : undefined}>{doc.header}</div>}<div className="word-page__body">{pageBlocks.map((block) => renderBlock(block, false))}{pageIndex === pages.length - 1 && <button className="word-add-block" type="button" contentEditable={false} onClick={() => update({ ...doc, blocks: [...doc.blocks, { id: nextBlockId('p'), kind: 'paragraph', text: '' }] })}>+ 添加段落</button>}</div>{(doc.footer || pageNumber) && <div className="word-page__footer" contentEditable={false} data-testid={pageIndex === 0 ? 'word-page-footer' : undefined}>{doc.footer && <span>{doc.footer}</span>}{pageNumber && <span className="word-page__number" aria-label="页码">{pageIndex + 1}</span>}</div>}</article>)}</div>}{localSelection && <LocalWordAssistantPopover projectId={projectId} outcomeId={outcomeId} selection={localSelection} anchor={localAnchor} hasUnsavedChanges={hasUnsavedChanges} close={() => { setLocalSelection(undefined); setCrossSelection(undefined); }} onApplied={onAssistantApplied} onConversationChanged={onConversationChanged} prepareSend={prepareCrossSelection} onNotice={onNotice} />}{citationOpen && <div className="citation-panel" role="dialog" aria-modal="true"><header><strong>插入引文</strong><button type="button" onClick={() => setCitationOpen(false)} aria-label="关闭"><X size={15} /></button></header><p>在当前光标处插入上角标，并在文末建立“参考文献”一级标题与编号条目。</p><textarea value={citation} onChange={(event) => setCitation(event.target.value)} placeholder="直接输入标准参考文献格式" /><footer><button type="button" onClick={() => setCitationOpen(false)}>取消</button><button className="primary" type="button" onClick={insertCitation}>插入</button></footer></div>}</div>;
}

function WordManagedImagePreview({ projectId, outcomeId, blockId, mediaId, mediaType, displayName }: { projectId: string; outcomeId: string; blockId: string; mediaId?: string; mediaType?: 'image/png' | 'image/jpeg'; displayName?: string }) {
  const [preview, setPreview] = useState<{ mediaId: string; url: string | null } | null>(null);
  const safeMediaId = mediaId && !mediaId.startsWith('docx-import-image-') ? mediaId : undefined;
  useEffect(() => {
    let current = true;
    if (!safeMediaId || !window.metis?.readOutcomeMedia) return () => { current = false; };
    void window.metis.readOutcomeMedia({ projectId, outcomeId, mediaId: safeMediaId }).then((value) => {
      if (current) setPreview({ mediaId: safeMediaId, url: typeof value === 'string' ? value : null });
    }).catch(() => { if (current) setPreview({ mediaId: safeMediaId, url: null }); });
    return () => { current = false; };
  }, [outcomeId, projectId, safeMediaId]);
  const url = safeMediaId && preview?.mediaId === safeMediaId ? preview.url : null;
  if (!mediaId || !mediaType || !displayName) return <figure className="word-image-block word-image-block--unsupported" data-block={blockId}><div>图片引用不完整，已安全降级为占位。</div></figure>;
  return <figure className="word-image-block" data-block={blockId}>{url ? <img src={url} alt={displayName} /> : <div className="word-image-block__placeholder">{safeMediaId ? `${displayName}（预览加载中或完整性校验未通过）` : `${displayName}（导入预览；保存时提交媒体）`}</div>}<figcaption>{displayName} · {mediaType}</figcaption></figure>;
}

function LocalWordAssistantPopover({ projectId, outcomeId, selection, anchor, hasUnsavedChanges, close, onApplied, onConversationChanged, prepareSend, onNotice }: { projectId: string; outcomeId: string; selection: Extract<AssistantSelection, { kind: 'word' }>; anchor: { left: number; top: number; bottom?: number }; hasUnsavedChanges: boolean; close: () => void; onApplied: (value: AssistantApplied | undefined) => Promise<void>; onConversationChanged: () => void; prepareSend?: () => Promise<{ selection: Extract<AssistantSelection, { kind: 'word' }> } | { error: string }>; onNotice?: (notice: string) => void }) {
  const [instruction, setInstruction] = useState(''); const [notice, setNotice] = useState(''); const [isSending, setIsSending] = useState(false);
  const popoverRef = useRef<HTMLElement>(null);
  const [placement, setPlacement] = useState({ left: anchor.left, top: anchor.top });
  useEffect(() => {
    const node = popoverRef.current;
    const rect = node?.getBoundingClientRect();
    const height = rect && rect.height > 0 ? rect.height : node?.offsetHeight ?? 0;
    const margin = 12;
    const maxTop = Math.max(margin, window.innerHeight - height - margin);
    let top = Math.min(anchor.top, maxTop);
    if (anchor.bottom !== undefined && top + height > anchor.bottom && anchor.bottom + margin <= maxTop) top = Math.min(anchor.bottom + margin, maxTop);
    setPlacement({ left: anchor.left, top: Math.max(margin, Math.min(top, maxTop)) });
  }, [anchor]);
  useEffect(() => {
    const dismiss = (event: Event) => { if (popoverRef.current && event.target instanceof Node && popoverRef.current.contains(event.target)) return; close(); };
    window.addEventListener('scroll', dismiss, true);
    window.addEventListener('resize', dismiss);
    return () => { window.removeEventListener('scroll', dismiss, true); window.removeEventListener('resize', dismiss); };
  }, [close]);
  useEffect(() => { const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') close(); }; window.addEventListener('keydown', escape); return () => window.removeEventListener('keydown', escape); }, [close]);
  const send = async (value: string) => {
    const trimmed = value.trim(); if (!trimmed || isSending) return;
    if (hasUnsavedChanges) { setNotice('当前草稿未保存。请先保存版本，再使用局部 AI。'); return; }
    const chat = assistantBridge()?.chatOutcomeAssistant;
    if (!chat) { setNotice('成果 AI 运行服务尚未就绪，未发送也未创建任何修改。'); return; }
    setIsSending(true); setNotice('');
    let effective = selection;
    if (prepareSend) {
      const prepared = await prepareSend();
      if ('error' in prepared) { setNotice(prepared.error); setIsSending(false); return; }
      effective = prepared.selection;
    }
    try {
      const result: AssistantResult = await chat({ projectId, outcomeId, instruction: trimmed, selection: requestSelection(effective) });
      setInstruction(''); onConversationChanged();
      if (result.status === 'completed') {
        if (result.applied) { await onApplied(result.applied); setNotice('AI 已将局部修改保存为新版本；右侧协作历史已同步。'); return; }
        setNotice(result.answer || result.assistantMessage?.content || 'AI 已回复。本轮没有生成可安全应用的结构化修改，因此成果内容未被改动。'); return;
      }
      const failed = result as unknown as { status: 'error' | 'cancelled'; code?: string; message?: string };
      const failText = failed.message || `本次局部协同未完成：${failed.code || failed.status}`;
      setNotice(failText);
    } catch {
      setNotice('局部 AI 请求没有完成，成果内容没有被修改。');
    } finally { setIsSending(false); }
  };
  // 任务5(2026-09-05):四个局部动作的指令可被 Office Profile slot 覆盖
  // (word.selection.rewrite/compress/expand/format);解析失败回退出厂默认。
  const [resolvedActions, setResolvedActions] = useState<Array<{ label: string; prompt: string }> | null>(null);
  useEffect(() => {
    let alive = true;
    const defaults: Array<{ label: string; slotId: string; prompt: string }> = [
      { label: '改写', slotId: 'word.selection.rewrite', prompt: '请在不改变含义的前提下改写所选文本，使其更清晰、准确。' },
      { label: '压缩', slotId: 'word.selection.compress', prompt: '请压缩所选文本，保留事实、论点与必要限定。' },
      { label: '扩写', slotId: 'word.selection.expand', prompt: '请在不虚构事实的前提下扩写所选文本，补足衔接与论证。' },
      { label: '格式', slotId: 'word.selection.format', prompt: '请优化所选文本的段落格式与表达层次。' },
    ];
    void (async () => {
      const resolved = await Promise.all(defaults.map(async (item) => {
        try {
          const response = await window.metis?.officePromptResolveSlot?.({ officeKind: 'word', outcomeId, slotId: item.slotId });
          return { label: item.label, prompt: response?.content?.trim() ? response.content : item.prompt };
        } catch { return { label: item.label, prompt: item.prompt }; }
      }));
      if (alive) setResolvedActions(resolved);
    })();
    return () => { alive = false; };
  }, [outcomeId]);
  const actions = (resolvedActions ?? [
    { label: '改写', prompt: '请在不改变含义的前提下改写所选文本，使其更清晰、准确。' },
    { label: '压缩', prompt: '请压缩所选文本，保留事实、论点与必要限定。' },
    { label: '扩写', prompt: '请在不虚构事实的前提下扩写所选文本，补足衔接与论证。' },
    { label: '润色', prompt: '请优化所选文本的表达层次与衔接，使论述更连贯、学术。' },
  ]).map((item) => [item.label, item.prompt] as const);
  return <section ref={popoverRef} className="word-local-ai" role="dialog" aria-label="所选文本 AI 操作" style={{ left: placement.left, top: placement.top }}><header><div><strong>AI 局部编辑</strong><small>已选 {selection.text.length} 个字符</small></div><button type="button" onClick={close} aria-label="关闭局部 AI 操作" title="关闭（Esc）"><X size={14} /></button></header><div className="word-local-ai__actions">{actions.map(([label, prompt]) => <button key={label} type="button" onClick={() => void send(prompt)} disabled={hasUnsavedChanges || isSending}>{label}</button>)}</div><label className="word-local-ai__instruction">补充指令<textarea aria-label="局部 AI 指令" value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(instruction); } }} placeholder="例如：保留术语，语气更严谨" disabled={hasUnsavedChanges || isSending} /></label>{hasUnsavedChanges && <p className="word-local-ai__notice" role="status">当前草稿未保存。请先保存版本，再使用局部 AI。</p>}{notice && <p className="word-local-ai__notice" role="status">{notice}</p>}<footer><span>Ctrl / ⌘ + Enter 发送</span><button className="primary" type="button" onClick={() => void send(instruction)} disabled={hasUnsavedChanges || isSending || !instruction.trim()}>{isSending ? <LoaderCircle size={14} className="spin" /> : <Send size={14} />}发送</button></footer></section>;
}

type PptEditorProps = { projectId: string; outcomeId: string; baseVersion: number; hasUnsavedChanges: boolean; document: PptDocument; initialPageId?: string; initialSelectedElementId?: string; onChange: (value: PptDocument) => void; onSave: (value: PptDocument) => void; onGenerationApplied: (value: PptGenerationApplied) => Promise<void>; onGenerationConflict: () => Promise<void>; onSelectionChange: (selection: AssistantSelection) => void; onNotice?: (notice: string) => void; controlledPageIndex?: number; controlledSelectedElementId?: string };

function PptStudioEditor(props: PptEditorProps) {
  const editorDocument: PptDocument = props.document.pages.length > 0 ? props.document : { ...props.document, pages: [{ id: 'slide-empty', title: '封面', pageType: 'cover', humanModified: false, status: 'draft', elements: [] }] };
  const initialPageIndex = props.initialPageId ? Math.max(0, editorDocument.pages.findIndex((page) => page.id === props.initialPageId)) : 0;
  const [pageIndex, setPageIndex] = useState(initialPageIndex);
  const [selectedElementId, setSelectedElementId] = useState<string | undefined>(props.initialSelectedElementId);
  const safePageIndex = Math.max(0, Math.min(pageIndex, Math.max(0, editorDocument.pages.length - 1)));
  const selectPage = (index: number, pageId = editorDocument.pages[index]?.id) => {
    setPageIndex(index);
    setSelectedElementId(undefined);
    if (pageId) props.onSelectionChange({ kind: 'ppt', pageId });
  };
  const selectElement = (elementId?: string) => {
    setSelectedElementId(elementId);
    const currentPage = editorDocument.pages[safePageIndex];
    if (currentPage) props.onSelectionChange({ kind: 'ppt', pageId: currentPage.id, ...(elementId ? { elementId } : {}) });
  };
  const saveDocument = () => props.onSave(withoutPristineFallbackPages(props.document));
  return <>
    <OfficePptRibbon document={editorDocument} pageIndex={safePageIndex} selectedElementId={selectedElementId} onChange={props.onChange} onSave={saveDocument} onSelectPage={selectPage} onSelectElement={selectElement} onNotice={(notice) => props.onNotice?.(notice)} />
    <LegacyPptStudioEditor {...props} document={editorDocument} controlledPageIndex={safePageIndex} controlledSelectedElementId={selectedElementId} onSelectionChange={(selection) => { if (selection?.kind === 'ppt') { const nextIndex = editorDocument.pages.findIndex((candidate) => candidate.id === selection.pageId); if (nextIndex >= 0) setPageIndex(nextIndex); setSelectedElementId(selection.elementId); } props.onSelectionChange(selection); }} />
  </>;
}

function LegacyPptStudioEditor({ projectId, outcomeId, baseVersion, hasUnsavedChanges, document, onChange, onSave, onGenerationApplied, onGenerationConflict, onSelectionChange, controlledPageIndex, controlledSelectedElementId }: PptEditorProps) {
  const { t } = useTranslation();
  useLayoutEffect(() => {
    const toolbar = window.document.querySelector<HTMLElement>('.ppt-studio > .ppt-toolbar');
    if (!toolbar) return undefined;
    toolbar.hidden = true;
    toolbar.setAttribute('aria-hidden', 'true');
    return () => { toolbar.hidden = false; toolbar.removeAttribute('aria-hidden'); };
  }, []);
  type PptPage = PptDocument['pages'][number];
  type PptElement = PptPage['elements'][number];
  type PptElementType = PptElement['type'];
  type DragState = { elementId: string; mode: 'move' | 'resize'; startX: number; startY: number; originX: number; originY: number; originWidth: number; originHeight: number };
  const elementOptions: Array<{ type: PptElementType; label: string; text: string }> = [
    { type: 'text', label: '文本', text: '输入文本' }, { type: 'rect', label: '矩形', text: '矩形' }, { type: 'roundRect', label: '圆角矩形', text: '圆角矩形' }, { type: 'ellipse', label: '椭圆', text: '椭圆' },
    { type: 'triangle', label: '三角', text: '三角' }, { type: 'line', label: '线', text: '线' }, { type: 'arrow', label: '箭头', text: '箭头' }, { type: 'table', label: '表格', text: '表格' },
    { type: 'chart', label: '图表', text: '图表占位' }, { type: 'image', label: '图片占位', text: '图片占位' },
  ];
  const emptyPage: PptPage = { id: 'slide-empty', title: '封面', pageType: 'cover', humanModified: false, status: 'draft', elements: [] };
  const doc: PptDocument = document.pages.length > 0 ? document : { ...document, pages: [emptyPage] };
  const [legacyPageIndex, setPageIndex] = useState(0);
  const [legacySelectedElementId, setSelectedElementId] = useState<string>();
  const pageIndex = controlledPageIndex ?? legacyPageIndex;
  const selectedElementId = controlledSelectedElementId ?? legacySelectedElementId;
  const [templates, setTemplates] = useState<PptTemplate[]>([]);
  const [defaultTemplateId, setDefaultTemplateId] = useState<string | null>(null);
  const [pendingDeleteTemplateId, setPendingDeleteTemplateId] = useState<string | null>(null);
  const [generationSkills, setGenerationSkills] = useState<PptGenerationSkill[]>([]);
  const [studioNotice, setStudioNotice] = useState('');
  const [generationInstruction, setGenerationInstruction] = useState('');
  const [isGenerating, setIsGenerating] = useState(false);
  const [imageGenerationPrompt, setImageGenerationPrompt] = useState('');
  const [imageGenerationQuality, setImageGenerationQuality] = useState<'standard' | 'hd' | 'low' | 'medium' | 'high'>('standard');
  const [isImageGenerating, setIsImageGenerating] = useState(false);
  const [skillEditorOpen, setSkillEditorOpen] = useState(false);
  const [saveTemplateOpen, setSaveTemplateOpen] = useState(false);
  const [templateNameDraft, setTemplateNameDraft] = useState('');
  const [skillDraft, setSkillDraft] = useState<Omit<PptGenerationSkill, 'id'>>({ name: '', narrative: 'argument_evidence', contentDensity: 'balanced', audience: '', instructions: '', layoutEngine: 'zone', themeProfileId: 'academic-blue' });
  const [drag, setDrag] = useState<DragState>();
  const stageRef = useRef<HTMLDivElement>(null);
  const imageGenerationInFlight = useRef(false);
  const latestDocument = useRef(document);
  const idRef = useRef(0);
  useEffect(() => { latestDocument.current = document; }, [document]);
  useEffect(() => {
    let current = true;
    const bridge = window.metis;
    if (!bridge) return () => { current = false; };
    void Promise.all([
      bridge.listOutcomeTemplates ? bridge.listOutcomeTemplates({ kind: 'ppt' }) : bridge.listPptTemplates(),
      bridge.listPptGenerationSkills(),
      bridge.getDefaultOutcomeTemplate?.({ kind: 'ppt' }),
    ]).then(([templateRows, skillRows, defaultRow]) => {
      if (!current) return;
      setTemplates((currentRows) => mergeRowsById(currentRows, Array.isArray(templateRows) ? templateRows as PptTemplate[] : []));
      setDefaultTemplateId(defaultRow && typeof defaultRow === 'object' && 'id' in defaultRow ? String((defaultRow as { id: unknown }).id) : null);
      setGenerationSkills((currentRows) => mergeRowsById(currentRows, Array.isArray(skillRows) ? skillRows as PptGenerationSkill[] : []));
    }).catch(() => { if (current) setStudioNotice('模板或生成技能列表暂不可用；当前成果编辑不受影响。'); });
    return () => { current = false; };
  }, []);
  const safePageIndex = Math.max(0, Math.min(pageIndex, doc.pages.length - 1));
  const page = doc.pages[safePageIndex]!;
  const grid = doc.ratio === '16:9' ? { w: 32, h: 18 } : { w: 24, h: 18 };
  const update = (next: PptDocument) => onChange(next);
  const mutatePage = (mutator: (current: PptPage) => PptPage) => update({ ...doc, pages: doc.pages.map((candidate, index) => index === safePageIndex ? mutator(candidate) : candidate) });
  const selectElement = (elementId?: string, pageId = page.id) => { setSelectedElementId(elementId); onSelectionChange({ kind: 'ppt', pageId, ...(elementId ? { elementId } : {}) }); };
  const clampElement = (element: PptElement, x = element.x, y = element.y, width = element.width, height = element.height): PptElement => {
    const boundedWidth = Math.max(1, Math.min(grid.w, Math.round(width)));
    const boundedHeight = Math.max(1, Math.min(grid.h, Math.round(height)));
    const boundedX = Math.max(0, Math.min(grid.w - boundedWidth, Math.round(x)));
    const boundedY = Math.max(0, Math.min(grid.h - boundedHeight, Math.round(y)));
    return { ...element, x: boundedX, y: boundedY, width: boundedWidth, height: boundedHeight };
  };
  const markChanged = (mutator: (current: PptPage) => PptPage) => mutatePage((current) => ({ ...mutator(current), humanModified: true }));
  useLayoutEffect(() => {
    const stage = stageRef.current;
    if (!stage) return undefined;
    const textElements = page.elements.filter((element) => element.type === 'text');
    const nodes = Array.from(stage.querySelectorAll<HTMLElement>('.ppt-element--text'));
    const cleanups = nodes.map((node, index) => {
      const target = textElements[index];
      if (!target) return () => undefined;
      node.contentEditable = target.locked ? 'false' : 'true';
      node.setAttribute('contenteditable', target.locked ? 'false' : 'true');
      if (target.locked) return () => undefined;
      const onInput = () => {
        const nextText = node.textContent ?? '';
        markChanged((current) => ({
          ...current,
          elements: current.elements.map((element) => element.id === target.id
            ? { ...element, props: { ...element.props, text: nextText } }
            : element),
        }));
      };
      node.addEventListener('input', onInput);
      return () => node.removeEventListener('input', onInput);
    });
    return () => cleanups.forEach((cleanup) => cleanup());
  // The DOM listener is intentionally attached after React commits the canvas;
  // the editor model is re-read on every render so direct text edits cannot
  // write against an outdated page snapshot.
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [doc, page.elements, safePageIndex]);
  const createId = (prefix: string) => {
    let id = '';
    do { idRef.current += 1; id = `${prefix}-${idRef.current}`; }
    while (doc.pages.some((candidate) => candidate.id === id || candidate.elements.some((element) => element.id === id)));
    return id;
  };
  const selectedElement = page.elements.find((element) => element.id === selectedElementId);
  const elementLabel = (type: PptElementType) => elementOptions.find((option) => option.type === type)?.label ?? type;
  const addElement = (type: PptElementType) => {
    const option = elementOptions.find((item) => item.type === type);
    const id = createId(type);
    const isLine = type === 'line' || type === 'arrow';
    const element: PptElement = { id, type, x: 3, y: 3, width: isLine ? 8 : 10, height: isLine ? 1 : 3, locked: false, props: { text: option?.text ?? type, zIndex: page.elements.length + 1 } };
    markChanged((current) => ({ ...current, elements: [...current.elements, clampElement(element)] }));
    selectElement(id);
  };
  const selectPage = (index: number) => { const candidate = doc.pages[index]; if (!candidate) return; setPageIndex(index); selectElement(undefined, candidate.id); };
  const updateSelected = (mutator: (element: PptElement) => PptElement) => { if (!selectedElement || selectedElement.locked) return; markChanged((current) => ({ ...current, elements: current.elements.map((element) => element.id === selectedElement.id ? mutator(element) : element) })); };
  const colorValue = (value: unknown, fallback: string) => typeof value === 'string' && /^#[0-9a-f]{6}$/iu.test(value) ? value : fallback;
  const themeRoles = [
    { key: 'primary', label: '主色', fallback: '#236c91' }, { key: 'accent', label: '强调', fallback: '#b66c2e' },
    { key: 'surface', label: '画布', fallback: '#ffffff' }, { key: 'text', label: '正文', fallback: '#183b59' },
  ] as const;
  const themeColor = (key: typeof themeRoles[number]['key'], fallback: string) => colorValue(doc.theme[key], fallback);
  const updateThemeColor = (key: typeof themeRoles[number]['key'], color: string) => update({ ...doc, theme: { ...doc.theme, [key]: color } });
  const updateSelectedProps = (patch: Record<string, unknown>) => updateSelected((element) => ({ ...element, props: { ...element.props, ...patch } }));
  type ImageCropPart = 'left' | 'top' | 'right' | 'bottom';
  const readImageCrop = (value: unknown): Record<ImageCropPart, number> => {
    const crop = asRecord(value);
    const parts = {
      left: typeof crop?.left === 'number' && Number.isFinite(crop.left) ? crop.left : 0,
      top: typeof crop?.top === 'number' && Number.isFinite(crop.top) ? crop.top : 0,
      right: typeof crop?.right === 'number' && Number.isFinite(crop.right) ? crop.right : 0,
      bottom: typeof crop?.bottom === 'number' && Number.isFinite(crop.bottom) ? crop.bottom : 0,
    };
    return parts.left >= 0 && parts.top >= 0 && parts.right >= 0 && parts.bottom >= 0 && parts.left < 1 && parts.top < 1 && parts.right < 1 && parts.bottom < 1 && parts.left + parts.right < 1 && parts.top + parts.bottom < 1 ? parts : { left: 0, top: 0, right: 0, bottom: 0 };
  };
  const updateImageCrop = (part: ImageCropPart, percent: string) => {
    if (!selectedElement || selectedElement.type !== 'image') return;
    const current = readImageCrop(selectedElement.props.crop);
    const opposite = part === 'left' ? current.right : part === 'right' ? current.left : part === 'top' ? current.bottom : current.top;
    const next = Math.max(0, Math.min(0.99 - opposite, (Number(percent) || 0) / 100));
    updateSelectedProps({ crop: { ...current, [part]: next } });
  };
  const updateImageOpacity = (percent: string) => updateSelectedProps({ opacity: Math.max(0, Math.min(1, (Number(percent) || 0) / 100)) });
  const openImageGeneration = () => { if (!selectedElement || selectedElement.type !== 'image') { setStudioNotice('请先选择一个图片占位元素，再生成并关联真实图片媒体。'); return; } setStudioNotice('请在右侧“AI 图片生成”面板输入提示词。生成结果会先写入当前草稿，保存后才成为版本。'); };
  const generateSelectedImage = async () => {
    if (imageGenerationInFlight.current || isImageGenerating) return;
    if (!selectedElement || selectedElement.type !== 'image') { setStudioNotice('请先选择一个图片占位元素，再生成图片。'); return; }
    if (hasUnsavedChanges) { setStudioNotice('当前 PPT 有未保存的编辑。请先保存为新版本，再生成图片，避免覆盖本地草稿。'); return; }
    if (!imageGenerationPrompt.trim()) { setStudioNotice('请输入图片生成提示词。'); return; }
    const generateImage = window.metis?.generateOutcomeImage;
    if (!generateImage) { setStudioNotice('图片生成运行服务尚未就绪；本次没有生成图片。'); return; }
    const targetId = selectedElement.id; const baseDocument = JSON.stringify(doc);
    const visualContext = JSON.stringify({ ratio: doc.ratio, grid, theme: doc.theme, themeColors: Object.fromEntries(themeRoles.map((role) => [role.key, themeColor(role.key, role.fallback)])), imageElement: { id: targetId, width: selectedElement.width, height: selectedElement.height, x: selectedElement.x, y: selectedElement.y, props: selectedElement.props } });
    imageGenerationInFlight.current = true; setIsImageGenerating(true); setStudioNotice('正在请求图片生成服务；返回前不会修改当前 PPT 版本。');
    try {
      const result = await generateImage({ projectId, outcomeId, prompt: imageGenerationPrompt.trim(), visualContext, quality: imageGenerationQuality });
      if (!result.ok) { setStudioNotice(imageGenerationFailureNotice(result.code)); return; }
      if (JSON.stringify(latestDocument.current) !== baseDocument) { setStudioNotice(`图片「${result.media.displayName}」已由主进程持久化，但当前 PPT 草稿已变化，未自动插入，避免覆盖编辑。`); return; }
      updateSelectedProps({ mediaId: result.media.id, mediaType: result.media.mediaType, displayName: result.media.displayName }); setImageGenerationPrompt('');
      setStudioNotice(`已将真实持久化图片「${result.media.displayName}」关联到当前图片占位。点击“保存”才会创建人工 PPT 版本；已保存且授权通过的 PNG/JPEG 会嵌入 PPTX，不支持或未持久化的图片会诚实降级为占位并提示。`);
    } catch { setStudioNotice('图片生成请求没有完成，当前 PPT 没有被修改。'); }
    finally { imageGenerationInFlight.current = false; setIsImageGenerating(false); }
  };
  const elementStyle = (element: PptElement): React.CSSProperties => {
    const props = element.props;
    const borderWidth = typeof props.borderWidth === 'number' && Number.isFinite(props.borderWidth) ? Math.max(0, Math.min(12, props.borderWidth)) : undefined;
    const fontSize = typeof props.fontSize === 'number' && Number.isFinite(props.fontSize) ? Math.max(6, Math.min(120, props.fontSize)) : undefined;
    const rotation = typeof props.rotationDeg === 'number' && Number.isFinite(props.rotationDeg) ? props.rotationDeg % 360 : undefined;
    const opacity = typeof props.opacity === 'number' && Number.isFinite(props.opacity) ? Math.max(0, Math.min(1, props.opacity)) : undefined;
    const flip = `${props.flipH === true ? ' scaleX(-1)' : ''}${props.flipV === true ? ' scaleY(-1)' : ''}`;
    const transform = rotation === undefined && !flip ? undefined : `rotate(${rotation ?? 0}deg)${flip}`;
    const mask = props.mask === 'ellipse' ? { borderRadius: '50%' } : props.mask === 'roundRect' ? { borderRadius: '12%' } : props.mask === 'triangle' ? { clipPath: 'polygon(50% 0, 100% 100%, 0 100%)' } : {};
    return {
      left: `${element.x / grid.w * 100}%`, top: `${element.y / grid.h * 100}%`, width: `${element.width / grid.w * 100}%`, height: `${element.height / grid.h * 100}%`, zIndex: Number(props.zIndex ?? 1),
      ...(typeof props.fillColor === 'string' ? { backgroundColor: colorValue(props.fillColor, themeColor('primary', '#236c91')) } : {}),
      ...(typeof props.borderColor === 'string' ? { borderColor: colorValue(props.borderColor, '#7d96a7') } : {}),
      ...(borderWidth !== undefined ? { borderWidth } : {}),
      color: colorValue(props.textColor, themeColor('text', '#183b59')),
      ...(fontSize !== undefined ? { fontSize } : {}),
      ...(typeof props.fontFamily === 'string' && props.fontFamily.trim() ? { fontFamily: props.fontFamily } : {}),
      ...(transform ? { transform } : {}),
      ...(opacity !== undefined ? { opacity } : {}),
      ...mask,
    };
  };
  const nudge = (x: number, y: number) => updateSelected((element) => clampElement(element, element.x + x, element.y + y));
  const resize = (width: number, height: number) => updateSelected((element) => clampElement(element, element.x, element.y, element.width + width, element.height + height));
  const deleteSelected = () => { if (!selectedElement || selectedElement.locked) return; markChanged((current) => ({ ...current, elements: current.elements.filter((element) => element.id !== selectedElement.id) })); selectElement(); };
  const duplicateSelected = () => { if (!selectedElement || selectedElement.locked) return; const copy = clampElement({ ...selectedElement, id: createId(selectedElement.type), x: selectedElement.x + 1, y: selectedElement.y + 1, props: { ...selectedElement.props, zIndex: Number(selectedElement.props.zIndex ?? 1) + 1 } }); markChanged((current) => ({ ...current, elements: [...current.elements, copy] })); selectElement(copy.id); };
  const setLayer = (position: 'front' | 'back') => updateSelected((element) => { const layers = page.elements.filter((item) => item.id !== element.id).map((item) => Number(item.props.zIndex ?? 1)); const nextLayer = position === 'front' ? Math.max(0, ...layers) + 1 : Math.max(1, Math.min(1, ...layers) - 1); return { ...element, props: { ...element.props, zIndex: nextLayer } }; });
  const toggleLock = () => { if (!selectedElement) return; markChanged((current) => ({ ...current, elements: current.elements.map((element) => element.id === selectedElement.id ? { ...element, locked: !element.locked } : element) })); };
  const updateContent = (content: string) => updateSelected((element) => ({ ...element, props: { ...element.props, text: content } }));
  const beginDrag = (event: React.PointerEvent<HTMLElement>, element: PptElement, mode: 'move' | 'resize') => { if (element.locked) return; event.stopPropagation(); event.currentTarget.setPointerCapture?.(event.pointerId); selectElement(element.id); setDrag({ elementId: element.id, mode, startX: event.clientX, startY: event.clientY, originX: element.x, originY: element.y, originWidth: element.width, originHeight: element.height }); };
  const moveDrag = (event: React.PointerEvent<HTMLElement>, element: PptElement) => { if (!drag || drag.elementId !== element.id || element.locked) return; const bounds = stageRef.current?.getBoundingClientRect(); if (!bounds || !bounds.width || !bounds.height) return; const deltaX = Math.round((event.clientX - drag.startX) / bounds.width * grid.w); const deltaY = Math.round((event.clientY - drag.startY) / bounds.height * grid.h); if (drag.mode === 'move') updateSelected((current) => clampElement(current, drag.originX + deltaX, drag.originY + deltaY)); else updateSelected((current) => clampElement(current, drag.originX, drag.originY, drag.originWidth + deltaX, drag.originHeight + deltaY)); };
  const stopDrag = (event: React.PointerEvent<HTMLElement>) => { if (drag) event.currentTarget.releasePointerCapture?.(event.pointerId); setDrag(undefined); };
  const setRatio = (ratio: PptDocument['ratio']) => { if (ratio === doc.ratio) return; const targetGrid = ratio === '16:9' ? { w: 32, h: 18 } : { w: 24, h: 18 }; update({ ...doc, ratio, pages: doc.pages.map((candidate) => ({ ...candidate, humanModified: candidate.humanModified || !isPristineFallbackPage(candidate), elements: candidate.elements.map((element) => { const width = Math.max(1, Math.min(targetGrid.w, element.width)); const height = Math.max(1, Math.min(targetGrid.h, element.height)); return { ...element, x: Math.max(0, Math.min(targetGrid.w - width, element.x)), y: Math.max(0, Math.min(targetGrid.h - height, element.y)), width, height }; }) })) }); };
  const changeTemplate = (id: string) => { const template = templates.find((item) => item.id === id); if (!template) { update({ ...doc, templateId: null }); setStudioNotice('已取消模板关联；当前页面与主题没有被改动。'); return; } update({ ...doc, templateId: template.id }); setStudioNotice(`已关联真实模板「${template.name}」，但尚未应用其比例、主题或页面布局。请先保存关联，再点击“应用模板内容”。`); };
  const applyTemplate = () => {
    if (hasUnsavedChanges) { setStudioNotice('当前 PPT 有未保存的编辑或模板关联。请先保存为新版本，再应用模板内容，避免覆盖本地草稿。'); return; }
    const template = templates.find((item) => item.id === doc.templateId);
    if (!template) { setStudioNotice(doc.templateId ? '当前关联的模板已不可用或尚未加载，当前成果没有被修改。' : '请先选择一个真实模板，再应用模板内容。'); return; }
    const parsed = applicablePptTemplate(template, doc.ratio);
    if (!parsed.value) { setStudioNotice(parsed.message ?? '模板无法应用，当前成果没有被修改。'); return; }
    const next = { ...doc, templateId: template.id, ...(parsed.value.ratio ? { ratio: parsed.value.ratio } : {}), ...(parsed.value.theme ? { theme: structuredClone(parsed.value.theme) } : {}), ...(parsed.value.pages ? { pages: copyTemplatePages(parsed.value.pages) } : {}) };
    update(next); setPageIndex(0); setSelectedElementId(undefined); onSelectionChange({ kind: 'ppt', pageId: next.pages[0]?.id ?? page.id });
    const parts = [parsed.value.ratio ? '比例' : '', parsed.value.theme ? '主题' : '', parsed.value.pages ? '页面布局' : ''].filter(Boolean).join('、');
    setStudioNotice(`已将模板「${template.name}」的${parts}应用到当前草稿；现在可继续编辑。点击“保存”才会创建人工版本。`);
  };
  const documentForSave = (): PptDocument => withoutPristineFallbackPages(doc);
  const templateDefinitionFromDoc = (): { ratio: PptDocument['ratio']; theme: Record<string, unknown>; pages?: PptPage[] } => {
    const pages = doc.pages.filter((candidate) => !isPristineFallbackPage(candidate));
    return { ratio: doc.ratio, theme: doc.theme, ...(pages.length > 0 ? { pages: copyTemplatePages(pages) } : {}) };
  };
  const persistTemplate = async (name: string) => {
    const bridge = window.metis;
    if (!bridge) return;
    try {
      const definition = templateDefinitionFromDoc();
      const saved = bridge.saveOutcomeTemplate
        ? await bridge.saveOutcomeTemplate({ kind: 'ppt', name, definition })
        : bridge.savePptTemplate ? await bridge.savePptTemplate({ name, definition }) : null;
      if (!saved) { setStudioNotice('模板未保存，当前成果内容没有被改变。'); return; }
      const template = saved as PptTemplate;
      setTemplates((rows) => [...rows.filter((item) => item.id !== template.id), template]);
      update({ ...doc, templateId: template.id });
      setStudioNotice(`模板「${template.name}」已保存并关联当前成果；当前页面没有被模板覆盖。请保存成果版本以持久化关联。`);
    } catch { setStudioNotice('模板保存请求未完成，当前成果内容没有被改变。'); }
  };
  const saveTemplate = async (rawName: string) => { const name = rawName.trim(); if (!name) return; setSaveTemplateOpen(false); await persistTemplate(name); };
  const renamePptTemplate = async () => {
    const name = templateNameDraft.trim();
    if (!doc.templateId || !name || !window.metis?.updateOutcomeTemplate) return;
    try {
      const saved = await window.metis.updateOutcomeTemplate({ id: doc.templateId, kind: 'ppt', name });
      if (!saved) { setStudioNotice('PPT 模板重命名未完成。'); return; }
      setTemplates((rows) => rows.map((item) => item.id === doc.templateId ? saved as PptTemplate : item)); setTemplateNameDraft(''); setStudioNotice(`PPT 模板已重命名为「${(saved as PptTemplate).name}」。`);
    } catch { setStudioNotice('PPT 模板重命名请求未完成。'); }
  };
  const updatePptTemplate = async () => {
    if (!doc.templateId || !window.metis?.updateOutcomeTemplate) return;
    try {
      const saved = await window.metis.updateOutcomeTemplate({ id: doc.templateId, kind: 'ppt', definition: templateDefinitionFromDoc() });
      if (!saved) { setStudioNotice('PPT 模板更新未完成。'); return; }
      setTemplates((rows) => rows.map((item) => item.id === doc.templateId ? saved as PptTemplate : item)); setStudioNotice(`PPT 模板「${(saved as PptTemplate).name}」已更新为当前样式。`);
    } catch { setStudioNotice('PPT 模板更新请求未完成。'); }
  };
  const deletePptTemplate = async () => {
    const id = pendingDeleteTemplateId;
    if (!id || !window.metis?.deleteOutcomeTemplate) return;
    try {
      if (!await window.metis.deleteOutcomeTemplate({ id, kind: 'ppt' })) { setStudioNotice('PPT 模板删除未完成。'); return; }
      setTemplates((rows) => rows.filter((item) => item.id !== id));
      if (defaultTemplateId === id) setDefaultTemplateId(null);
      if (doc.templateId === id) update({ ...doc, templateId: null });
      setPendingDeleteTemplateId(null); setStudioNotice('PPT 模板已删除，当前成果内容未被修改。');
    } catch { setStudioNotice('PPT 模板删除请求未完成。'); }
  };
  const setPptDefaultTemplate = async () => {
    if (!doc.templateId || !window.metis?.setDefaultOutcomeTemplate) return;
    try {
      if (await window.metis.setDefaultOutcomeTemplate({ kind: 'ppt', templateId: doc.templateId })) { setDefaultTemplateId(doc.templateId); setStudioNotice('已设为 PPT 新建成果默认模板。'); } else setStudioNotice('PPT 默认模板设置未完成。');
    } catch { setStudioNotice('PPT 默认模板设置请求未完成。'); }
  };
  const clearPptDefaultTemplate = async () => {
    if (!defaultTemplateId || !window.metis?.setDefaultOutcomeTemplate) return;
    try {
      if (await window.metis.setDefaultOutcomeTemplate({ kind: 'ppt', templateId: null })) { setDefaultTemplateId(null); setStudioNotice('已取消 PPT 新建成果默认模板。'); } else setStudioNotice('PPT 默认模板取消未完成。');
    } catch { setStudioNotice('PPT 默认模板取消请求未完成。'); }
  };
  const saveGenerationSkill = async () => {
    if (!skillDraft.name.trim()) { setStudioNotice('请填写生成技能名称。'); return; }
    if (!window.metis?.savePptGenerationSkill) { setStudioNotice('PPT Generation Skill 保存服务尚未就绪，未创建技能。'); return; }
    try {
      const saved = await window.metis.savePptGenerationSkill({ ...skillDraft, name: skillDraft.name.trim(), audience: skillDraft.audience.trim(), instructions: skillDraft.instructions.trim() });
      if (!saved) { setStudioNotice('生成技能未保存，当前成果内容没有被改变。'); return; }
      const skill = saved as PptGenerationSkill;
      setGenerationSkills((rows) => [skill, ...rows.filter((item) => item.id !== skill.id)]);
      update({ ...doc, generationSkillId: skill.id }); setSkillEditorOpen(false);
      setStudioNotice(`已创建并选择真实生成技能「${skill.name}」。请保存当前成果版本后再运行。`);
    } catch { setStudioNotice('生成技能保存请求未完成，当前成果内容没有被改变。'); }
  };
  const executeGeneration = async () => {
    if (isGenerating) return;
    if (hasUnsavedChanges) { setStudioNotice('当前 PPT 有未保存的编辑。请先保存为新版本，再运行 Generation Skill，避免覆盖本地草稿。'); return; }
    if (!doc.generationSkillId) { setStudioNotice('请先选择一个 PPT 生成技能并保存当前成果版本。'); return; }
    if (!generationInstruction.trim()) { setStudioNotice('请输入本次 PPT 生成指令。'); return; }
    const execute = window.metis?.executeOutcomePptGeneration;
    if (!execute) { setStudioNotice('PPT Generation Skill 运行服务尚未就绪；本次没有生成或修改成果。'); return; }
    setIsGenerating(true); setStudioNotice('正在调用已选 Generation Skill；完成前不会修改本地草稿。');
    try {
      const result: PptGenerationResult = await execute({ projectId, outcomeId, baseVersion, generationSkillId: doc.generationSkillId, templateId: doc.templateId, instruction: generationInstruction.trim() });
      if (result.status === 'completed') { setGenerationInstruction(''); await onGenerationApplied(result.applied); return; }
      if (result.code === 'outcome_version_conflict') { await onGenerationConflict(); return; }
      setStudioNotice(result.message || `PPT 生成未完成：${result.code}`);
    } catch { setStudioNotice('PPT Generation Skill 请求没有完成，当前成果没有被修改。'); }
    finally { setIsGenerating(false); }
  };
  return <div className="ppt-studio">
    <div className="ppt-toolbar" aria-label="PPT 编辑工具栏"><span>{doc.ratio} · {grid.w} × {grid.h} Grid</span><div className="ppt-toolbar__ratio" role="group" aria-label="页面比例"><button type="button" className={doc.ratio === '16:9' ? 'active' : ''} onClick={() => setRatio('16:9')}>16:9</button><button type="button" className={doc.ratio === '4:3' ? 'active' : ''} onClick={() => setRatio('4:3')}>4:3</button></div><select aria-label="添加 PPT 元素" defaultValue="" onChange={(event) => { if (event.target.value) { addElement(event.target.value as PptElementType); event.currentTarget.value = ''; } }}><option value="" disabled>添加元素</option>{elementOptions.map((option) => <option key={option.type} value={option.type}>{option.label}</option>)}</select><button type="button" onClick={() => addElement('text')}><Type size={15} />文本</button><button type="button" onClick={() => addElement('rect')}><Plus size={15} />矩形</button><button type="button" onClick={() => addElement('table')}><Table2 size={15} />表格</button><button type="button" onClick={openImageGeneration} disabled={isImageGenerating}><ImageIcon size={15} />AI 图片</button><button type="button" onClick={() => onSave(documentForSave())}><Save size={15} />保存</button></div>
    <div className="ppt-template-strip" aria-label="PPT 模板与生成技能"><label>{t('outcomePptTemplates.fieldLabel')}<select aria-label="选择 PPT 模板" value={doc.templateId ?? ''} onChange={(event) => changeTemplate(event.target.value)}><option value="">{t('outcomePptTemplates.selectNone')}</option>{templates.map((template) => <option key={template.id} value={template.id}>{template.name}{template.id === defaultTemplateId ? t('outcomePptTemplates.defaultSuffix') : ''}</option>)}</select></label><button type="button" onClick={() => setSaveTemplateOpen(true)} disabled={!window.metis?.saveOutcomeTemplate && !window.metis?.savePptTemplate}>{t('outcomePptTemplates.saveAs')}</button><button className="ppt-template-apply" type="button" onClick={applyTemplate} disabled={!doc.templateId} title="将所选模板的可用比例、主题和页面布局写入当前草稿">{t('outcomePptTemplates.apply')}</button><input aria-label={t('outcomePptTemplates.nameLabel')} value={templateNameDraft} onChange={(event) => setTemplateNameDraft(event.target.value)} placeholder={t('outcomePptTemplates.namePlaceholder')} /><button type="button" onClick={() => void renamePptTemplate()} disabled={!doc.templateId || !templateNameDraft.trim()}>{t('outcomePptTemplates.rename')}</button><button type="button" onClick={() => void updatePptTemplate()} disabled={!doc.templateId}>{t('outcomePptTemplates.updateCurrent')}</button><button type="button" onClick={() => void setPptDefaultTemplate()} disabled={!doc.templateId}>{t('outcomePptTemplates.setDefault')}</button><button type="button" onClick={() => void clearPptDefaultTemplate()} disabled={!defaultTemplateId}>{t('outcomePptTemplates.clearDefault')}</button><button type="button" onClick={() => setPendingDeleteTemplateId(doc.templateId)} disabled={!doc.templateId}>{t('outcomePptTemplates.delete')}</button>{pendingDeleteTemplateId && <div className="ppt-template-confirm" role="alert"><span>{t('outcomePptTemplates.confirmDelete', { name: templates.find((item) => item.id === pendingDeleteTemplateId)?.name ?? pendingDeleteTemplateId })}</span><button type="button" onClick={() => void deletePptTemplate()}>{t('outcomePptTemplates.confirm')}</button><button type="button" onClick={() => setPendingDeleteTemplateId(null)}>{t('outcomePptTemplates.cancel')}</button></div>}<small className="ppt-template-association" role="status">{hasUnsavedChanges ? '当前有未保存编辑或模板关联；先保存版本后才可应用，避免覆盖草稿。' : doc.templateId ? '当前仅关联模板，尚未覆盖页面；点击“应用模板内容”后仍需手动保存。' : '选择模板只建立关联，不会覆盖当前页面。'}</small><label>生成技能<select aria-label="选择 PPT 生成技能" value={doc.generationSkillId ?? ''} onChange={(event) => update({ ...doc, generationSkillId: event.target.value || null })}><option value="">不关联生成技能</option>{generationSkills.map((skill) => <option key={skill.id} value={skill.id}>{skill.name}</option>)}</select></label><button type="button" onClick={() => setSkillEditorOpen(true)} disabled={!window.metis?.savePptGenerationSkill}>新建技能</button><input className="ppt-generation-instruction" aria-label="PPT 生成指令" value={generationInstruction} onChange={(event) => setGenerationInstruction(event.target.value)} placeholder="例如：把本页扩展为答辩逻辑" disabled={isGenerating} /><button className="ppt-generation-action" type="button" onClick={() => void executeGeneration()} disabled={isGenerating || hasUnsavedChanges || !doc.generationSkillId || !generationInstruction.trim()}>{isGenerating ? <LoaderCircle size={14} className="spin" /> : <Sparkles size={14} />}运行生成</button><small>{hasUnsavedChanges ? '当前有未保存编辑；保存为新版本后才能运行。' : doc.generationSkillId ? '运行前会核验当前版本；仅服务端成功保存的新版本才会显示。' : '选择或新建生成技能并保存当前成果版本后，才能运行。'}</small></div>
    {studioNotice && <p className="ppt-studio__notice" role="status">{studioNotice}</p>}
    {skillEditorOpen && <section className="ppt-skill-editor" role="dialog" aria-label="新建 PPT 生成技能"><header><div><strong>新建生成技能</strong><small>保存后会真实写入技能库，并自动选中。</small></div><button type="button" aria-label="关闭新建生成技能" onClick={() => setSkillEditorOpen(false)}><X size={15} /></button></header><label>名称<input aria-label="生成技能名称" value={skillDraft.name} onChange={(event) => setSkillDraft((current) => ({ ...current, name: event.target.value }))} autoFocus /></label><div className="ppt-skill-editor__row"><label>叙事<select aria-label="生成技能叙事" value={skillDraft.narrative} onChange={(event) => setSkillDraft((current) => ({ ...current, narrative: event.target.value as PptGenerationSkill['narrative'] }))}><option value="argument_evidence">论点与证据</option><option value="problem_solution">问题与方案</option><option value="timeline">时间线</option><option value="comparison">比较</option><option value="minimal_report">极简汇报</option></select></label><label>信息密度<select aria-label="生成技能信息密度" value={skillDraft.contentDensity} onChange={(event) => setSkillDraft((current) => ({ ...current, contentDensity: event.target.value as PptGenerationSkill['contentDensity'] }))}><option value="sparse">精简</option><option value="balanced">均衡</option><option value="dense">详实</option></select></label><label>版式引擎<select aria-label="版式引擎" value={skillDraft.layoutEngine ?? 'zone'} onChange={(event) => setSkillDraft((current) => ({ ...current, layoutEngine: event.target.value as PptGenerationSkill['layoutEngine'] }))}><option value="zone">zone 版式引擎（推荐）</option><option value="legacy">传统（模型直出）</option></select></label><label>主题风格<select aria-label="主题风格" value={skillDraft.themeProfileId ?? 'academic-blue'} onChange={(event) => setSkillDraft((current) => ({ ...current, themeProfileId: event.target.value }))}><option value="academic-blue">学术蓝（通用）</option><option value="gov-red">政务红（通用）</option><option value="tech-slate">科技深空（通用）</option><option value="minimal-mono">极简黑白（通用）</option><option value="wut">武汉理工（校徽蓝三件套）</option></select></label></div><label>受众<input aria-label="生成技能受众" value={skillDraft.audience} placeholder="例如：项目评审专家" onChange={(event) => setSkillDraft((current) => ({ ...current, audience: event.target.value }))} /></label><label>说明<textarea aria-label="生成技能说明" value={skillDraft.instructions} placeholder="说明所需结构、证据和表达约束" onChange={(event) => setSkillDraft((current) => ({ ...current, instructions: event.target.value }))} /></label><footer><button type="button" onClick={() => setSkillEditorOpen(false)}>取消</button><button className="primary" type="button" onClick={() => void saveGenerationSkill()}>保存技能</button></footer></section>}
    {saveTemplateOpen && <PromptDialog title="保存为 PPT 模板" fieldLabel="模板名称" confirmLabel="保存模板" close={() => setSaveTemplateOpen(false)} submit={(value) => void saveTemplate(value)} />}
    <div className="ppt-editor-body"><nav className="ppt-slides" aria-label="幻灯片列表">{doc.pages.map((candidate, index) => <button key={candidate.id} type="button" className={index === safePageIndex ? 'selected' : ''} onClick={() => selectPage(index)}><small>{String(index + 1).padStart(2, '0')}</small><strong>{candidate.title}</strong><span>{candidate.humanModified ? '人工修改' : candidate.status === 'draft' ? '草稿' : '完成'}</span></button>)}<button type="button" className="ppt-slides__add" onClick={() => { const id = createId('slide'); update({ ...doc, pages: [...doc.pages, { id, title: `第 ${doc.pages.length + 1} 页`, pageType: 'content', humanModified: true, status: 'draft', elements: [] }] }); setPageIndex(doc.pages.length); selectElement(undefined, id); }}><Plus size={14} />新建页</button></nav>
      <div className="ppt-canvas-wrap"><div ref={stageRef} className="ppt-stage" style={{ aspectRatio: doc.ratio.replace(':', ' / '), '--ppt-primary': themeColor('primary', '#236c91'), '--ppt-accent': themeColor('accent', '#b66c2e'), '--ppt-surface': themeColor('surface', '#ffffff'), '--ppt-text': themeColor('text', '#183b59') } as React.CSSProperties} onClick={() => selectElement()}>{Array.from({ length: grid.w * grid.h }).map((_, index) => <i key={index} style={{ left: `${(index % grid.w) / grid.w * 100}%`, top: `${Math.floor(index / grid.w) / grid.h * 100}%` }} />)}{page.elements.map((element) => <div key={element.id} role="button" tabIndex={0} aria-label={`选择${elementLabel(element.type)}`} className={`ppt-element ppt-element--${element.type} ${selectedElementId === element.id ? 'selected' : ''} ${element.locked ? 'locked' : ''}`} onClick={(event) => { event.stopPropagation(); selectElement(element.id); }} onPointerDown={(event) => beginDrag(event, element, 'move')} onPointerMove={(event) => moveDrag(event, element)} onPointerUp={stopDrag} onKeyDown={(event) => { if (event.key === 'Delete') { event.preventDefault(); selectElement(element.id); deleteSelected(); } if (event.key === 'ArrowLeft') { event.preventDefault(); selectElement(element.id); nudge(-1, 0); } if (event.key === 'ArrowRight') { event.preventDefault(); selectElement(element.id); nudge(1, 0); } if (event.key === 'ArrowUp') { event.preventDefault(); selectElement(element.id); nudge(0, -1); } if (event.key === 'ArrowDown') { event.preventDefault(); selectElement(element.id); nudge(0, 1); } }} style={elementStyle(element)}>{element.type === 'image' && typeof element.props.mediaId === 'string' ? <PptManagedImagePreview projectId={projectId} outcomeId={outcomeId} mediaId={element.props.mediaId} displayName={typeof element.props.displayName === 'string' ? element.props.displayName : '已生成图片'} crop={readImageCrop(element.props.crop)} /> : <span>{String(element.props.text ?? elementLabel(element.type))}</span>}{selectedElementId === element.id && !element.locked && <button type="button" className="ppt-element__resize" aria-label="拖动调整大小" onPointerDown={(event) => beginDrag(event, element, 'resize')} />}</div>)}</div></div>
      <aside className="ppt-properties" aria-label="PPT 元素属性">{selectedElement ? <><header><div><small>已选中</small><strong>{elementLabel(selectedElement.type)}{selectedElement.locked ? ' · 已锁定' : ''}</strong></div><button type="button" onClick={deleteSelected} disabled={selectedElement.locked} title="删除元素" aria-label="删除元素"><Trash2 size={15} /></button></header><section><label>内容 / 说明<input aria-label="元素内容" value={String(selectedElement.props.text ?? '')} disabled={selectedElement.locked} onChange={(event) => updateContent(event.target.value)} /></label></section>{selectedElement.type === 'image' && <section className="ppt-properties__image"><span>图片交互属性</span><div className="ppt-properties__image-grid"><label>旋转（度）<input aria-label="图片旋转角度" type="number" min="-360" max="360" step="1" value={typeof selectedElement.props.rotationDeg === 'number' && Number.isFinite(selectedElement.props.rotationDeg) ? selectedElement.props.rotationDeg : 0} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ rotationDeg: Math.max(-360, Math.min(360, Number(event.target.value) || 0)) })} /></label><label>透明度（%）<input aria-label="图片透明度" type="number" min="0" max="100" step="1" value={typeof selectedElement.props.opacity === 'number' && Number.isFinite(selectedElement.props.opacity) ? Math.round(Math.max(0, Math.min(1, selectedElement.props.opacity)) * 100) : 100} disabled={selectedElement.locked} onChange={(event) => updateImageOpacity(event.target.value)} /></label><label>蒙版<select aria-label="图片蒙版" value={selectedElement.props.mask === 'roundRect' || selectedElement.props.mask === 'ellipse' || selectedElement.props.mask === 'triangle' ? selectedElement.props.mask : 'rect'} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ mask: event.target.value })}><option value="rect">矩形</option><option value="roundRect">圆角矩形</option><option value="ellipse">椭圆</option><option value="triangle">三角形</option></select></label></div><div className="ppt-properties__image-flips"><label><input aria-label="水平翻转" type="checkbox" checked={selectedElement.props.flipH === true} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ flipH: event.target.checked })} />水平翻转</label><label><input aria-label="垂直翻转" type="checkbox" checked={selectedElement.props.flipV === true} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ flipV: event.target.checked })} />垂直翻转</label></div><div className="ppt-properties__crop"><span>裁切（图片边缘百分比）</span>{(['left', 'top', 'right', 'bottom'] as const).map((part) => <label key={part}>{part === 'left' ? '左' : part === 'top' ? '上' : part === 'right' ? '右' : '下'}<input aria-label={`图片裁切${part === 'left' ? '左' : part === 'top' ? '上' : part === 'right' ? '右' : '下'}`} type="number" min="0" max="99" step="1" value={Math.round(readImageCrop(selectedElement.props.crop)[part] * 100)} disabled={selectedElement.locked} onChange={(event) => updateImageCrop(part, event.target.value)} /></label>)}</div><p className="ppt-properties__draft-status" role="status">{hasUnsavedChanges ? '图片属性已写入当前 PPT 草稿；点击“保存”创建新版本。' : '图片属性已保存到当前版本。'}</p></section>}<section className="ppt-properties__colors"><span>元素样式</span><div><label>填充色<input aria-label="填充色" type="color" value={colorValue(selectedElement.props.fillColor, themeColor('primary', '#236c91'))} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ fillColor: event.target.value })} /></label><label>边框颜色<input aria-label="边框颜色" type="color" value={colorValue(selectedElement.props.borderColor, '#7d96a7')} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ borderColor: event.target.value })} /></label><label>边框宽度<input aria-label="边框宽度" type="number" min="0" max="12" value={typeof selectedElement.props.borderWidth === 'number' ? selectedElement.props.borderWidth : 1} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ borderWidth: Math.max(0, Math.min(12, Number(event.target.value) || 0)) })} /></label><label>文字颜色<input aria-label="文字颜色" type="color" value={colorValue(selectedElement.props.textColor, themeColor('text', '#183b59'))} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ textColor: event.target.value })} /></label><label>字号<input aria-label="PPT 字号" type="number" min="6" max="120" value={typeof selectedElement.props.fontSize === 'number' ? selectedElement.props.fontSize : 14} disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ fontSize: Math.max(6, Math.min(120, Number(event.target.value) || 14)) })} /></label><label>字体<input aria-label="PPT 字体" value={typeof selectedElement.props.fontFamily === 'string' ? selectedElement.props.fontFamily : ''} placeholder="继承主题" disabled={selectedElement.locked} onChange={(event) => updateSelectedProps({ fontFamily: event.target.value })} /></label></div></section><section className="ppt-properties__palette"><span>主题色板</span><div>{themeRoles.map((role) => <button key={role.key} type="button" aria-label={`应用主题${role.label}为填充色`} title={`用主题${role.label}作为填充色`} disabled={selectedElement.locked} style={{ backgroundColor: themeColor(role.key, role.fallback) }} onClick={() => updateSelectedProps({ fillColor: themeColor(role.key, role.fallback) })} />)}</div></section><section className="ppt-properties__theme"><span>文稿主题</span><div>{themeRoles.map((role) => <label key={role.key}>{role.label}<input aria-label={`主题${role.label}`} type="color" value={themeColor(role.key, role.fallback)} onChange={(event) => updateThemeColor(role.key, event.target.value)} /></label>)}</div></section><section><span>位置（Grid）</span><div className="ppt-nudge"><button type="button" aria-label="向上移动 1 Grid" disabled={selectedElement.locked} onClick={() => nudge(0, -1)}><ArrowUp size={14} /></button><button type="button" aria-label="向左移动 1 Grid" disabled={selectedElement.locked} onClick={() => nudge(-1, 0)}><ArrowLeft size={14} /></button><button type="button" aria-label="向右移动 1 Grid" disabled={selectedElement.locked} onClick={() => nudge(1, 0)}><ArrowRight size={14} /></button><button type="button" aria-label="向下移动 1 Grid" disabled={selectedElement.locked} onClick={() => nudge(0, 1)}><ArrowDown size={14} /></button></div></section><section><span>尺寸（Grid）</span><div className="ppt-size"><button type="button" aria-label="宽度减 1 Grid" disabled={selectedElement.locked} onClick={() => resize(-1, 0)}><Minus size={14} /></button><b>{selectedElement.width} × {selectedElement.height}</b><button type="button" aria-label="宽度加 1 Grid" disabled={selectedElement.locked} onClick={() => resize(1, 0)}><Plus size={14} /></button><button type="button" aria-label="高度加 1 Grid" disabled={selectedElement.locked} onClick={() => resize(0, 1)}><Maximize2 size={14} /></button></div></section><section className="ppt-properties__actions"><button type="button" disabled={selectedElement.locked} onClick={duplicateSelected}><Copy size={14} />复制</button><button type="button" disabled={selectedElement.locked} onClick={() => setLayer('front')}>置于顶层</button><button type="button" disabled={selectedElement.locked} onClick={() => setLayer('back')}>置于底层</button><button type="button" onClick={toggleLock}>{selectedElement.locked ? '解除锁定' : '锁定'}</button></section><p className="ppt-properties__unsupported">渐变、多选分组和复杂矢量编辑暂不支持；图片媒体仅接受当前 codec 可验证的 PNG/JPEG 与安全 SVG，GIF/WebP 会明确降级为占位；安全 SVG 只作为媒体处理，不提供矢量编辑。</p></> : <div className="ppt-properties__empty"><Move size={20} /><p>选择一个元素后，可用鼠标拖拽、右下角缩放或按 Grid 精确编辑。</p></div>}</aside>
    </div>
    {selectedElement?.type === 'image' && <section className="ppt-image-generator" aria-label="AI 图片生成"><header><div><strong>AI 图片生成</strong><small>目标：{selectedElement.width} × {selectedElement.height} Grid。生成后先关联当前草稿，保存才创建版本。</small></div></header><label>图片提示词<textarea aria-label="PPT 图片生成提示词" value={imageGenerationPrompt} onChange={(event) => setImageGenerationPrompt(event.target.value)} placeholder="例如：与当前研究主题一致的克制信息图插图" disabled={isImageGenerating || hasUnsavedChanges || selectedElement.locked} /></label><label>质量<select aria-label="PPT 图片生成质量" value={imageGenerationQuality} onChange={(event) => setImageGenerationQuality(event.target.value as typeof imageGenerationQuality)} disabled={isImageGenerating || hasUnsavedChanges || selectedElement.locked}><option value="standard">标准</option><option value="hd">高清</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><button className="primary" type="button" onClick={() => void generateSelectedImage()} disabled={isImageGenerating || hasUnsavedChanges || selectedElement.locked || !imageGenerationPrompt.trim()}>{isImageGenerating ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}生成并关联图片</button>{hasUnsavedChanges && <p role="status">当前 PPT 有未保存编辑；先保存版本后才能生成图片。</p>}{selectedElement.locked && <p role="status">当前图片元素已锁定；解除锁定后才能关联新媒体。</p>}{isImageGenerating && <p role="status">生成中。当前桥接未提供取消请求能力，不能伪称已取消。</p>}<p className="ppt-image-generator__export-boundary">PPTX 导出仅对已持久化且通过校验的 PNG/JPEG 与安全 SVG 生成真实图片；GIF/WebP 会明确降级为占位，SVG 不提供矢量编辑。</p></section>}
  </div>;
}

function PptManagedImagePreview({ projectId, outcomeId, mediaId, displayName, crop }: { projectId: string; outcomeId: string; mediaId: string; displayName: string; crop: { left: number; top: number; right: number; bottom: number } }) {
  const [preview, setPreview] = useState<{ mediaId: string; url: string | null } | null>(null); const url = preview?.mediaId === mediaId ? preview.url : null;
  useEffect(() => { let current = true; if (!window.metis?.readOutcomeMedia) return () => { current = false; }; void window.metis.readOutcomeMedia({ projectId, outcomeId, mediaId }).then((value) => { if (current) setPreview({ mediaId, url: typeof value === 'string' ? value : null }); }).catch(() => { if (current) setPreview({ mediaId, url: null }); }); return () => { current = false; }; }, [mediaId, outcomeId, projectId]);
  const visibleWidth = Math.max(0.01, 1 - crop.left - crop.right);
  const visibleHeight = Math.max(0.01, 1 - crop.top - crop.bottom);
  const imageStyle: React.CSSProperties = { width: `${100 / visibleWidth}%`, height: `${100 / visibleHeight}%`, maxWidth: 'none', maxHeight: 'none', position: 'relative', left: `${-crop.left / visibleWidth * 100}%`, top: `${-crop.top / visibleHeight * 100}%` };
  return url ? <img className="ppt-element__managed-image" style={imageStyle} src={url} alt={displayName} /> : <span>{displayName}（预览加载中）</span>;
}

function MediaEditor({ projectId, outcomeId, kind, hasUnsavedChanges, document, onChange, onSave }: { projectId: string; outcomeId: string; kind: OutcomeKind; hasUnsavedChanges: boolean; document: Extract<OutcomeDocument, { type: 'other' | 'spreadsheet' | 'pdf' }>; onChange: (value: Extract<OutcomeDocument, { type: 'other' | 'spreadsheet' | 'pdf' }>) => void; onSave: (value: Extract<OutcomeDocument, { type: 'other' | 'spreadsheet' | 'pdf' }>, note: string, actor?: 'human' | 'import') => void }) {
  const [preview, setPreview] = useState<{ mediaId: string; url: string | null } | null>(null); const [prompt, setPrompt] = useState(''); const [quality, setQuality] = useState<'standard' | 'hd' | 'low' | 'medium' | 'high'>('standard'); const [notice, setNotice] = useState(''); const [isGenerating, setIsGenerating] = useState(false); const generationInFlight = useRef(false); const media = document.media; const url = media && preview?.mediaId === media.id ? preview.url : null;
  useEffect(() => { let current = true; if (!media || !window.metis?.readOutcomeMedia) return () => { current = false; }; void window.metis.readOutcomeMedia({ projectId, outcomeId, mediaId: media.id }).then((value) => { if (current) setPreview({ mediaId: media.id, url: typeof value === 'string' ? value : null }); }).catch(() => { if (current) setPreview({ mediaId: media.id, url: null }); }); return () => { current = false; }; }, [media, projectId, outcomeId]);
  const importFile = async () => { const value = await window.metis?.importOutcomeMedia({ projectId, outcomeId }) as OutcomeMedia | null; if (value) onSave({ ...document, media: value }, `导入 ${value.displayName}`, 'import'); };
  const exportSvgFile = async () => {
    if (!media || media.mediaType !== 'image/svg+xml') return;
    const exportBridge = window.metis?.exportOutcomeMediaSvg;
    if (!exportBridge) { setNotice('当前版本缺少 SVG 导出桥接；本次没有写出文件。'); return; }
    setNotice('正在导出安全 SVG 副本…');
    try {
      const result = await exportBridge({ projectId, outcomeId, mediaId: media.id });
      setNotice(result.ok ? `已导出 ${result.fileName}；导出副本经过独立安全校验。` : result.message);
    } catch { setNotice('SVG 导出请求没有完成；当前成果没有被修改。'); }
  };
  const generate = async () => {
    if (generationInFlight.current || isGenerating) return;
    if (hasUnsavedChanges) { setNotice('当前图片成果有未保存的编辑。请先保存版本，再生成新图片，避免覆盖本地草稿。'); return; }
    if (!prompt.trim()) { setNotice('请输入图片生成提示词。'); return; }
    const generateImage = window.metis?.generateOutcomeImage;
    if (!generateImage) { setNotice('图片生成运行服务尚未就绪；本次没有生成图片。'); return; }
    generationInFlight.current = true; setIsGenerating(true); setNotice('正在请求图片生成服务；返回前不会修改当前成果版本。');
    try {
     const description = document.type === 'other' ? document.text.trim() : '';
     const result = await generateImage({ projectId, outcomeId, prompt: prompt.trim(), visualContext: `成果类型：图片。${description ? `成果说明：${description}` : '当前没有额外文字说明。'}${media ? ` 当前媒体：${media.displayName}。` : ''}`, quality });
      if (!result.ok) { setNotice(imageGenerationFailureNotice(result.code)); return; }
      onChange({ ...document, media: result.media }); setPrompt(''); setNotice(`已收到并引用真实持久化图片「${result.media.displayName}」。预览加载后，请点击“保存图片版本”使其成为不可变版本。`);
    } catch { setNotice('图片生成请求没有完成，当前成果没有被修改。'); }
    finally { generationInFlight.current = false; setIsGenerating(false); }
  };
  return <div className="outcome-media-preview"><header><strong>{media?.displayName ?? (kind === 'image' ? 'AI 图片成果' : kind === 'spreadsheet' ? 'Excel 成果' : kind === 'pdf' ? 'PDF 成果' : '其他正式交付物')}</strong><div><button type="button" onClick={() => void importFile()}><Upload size={15} />{media ? '替换文件' : '导入文件'}</button>{media?.mediaType === 'image/svg+xml' && <button type="button" onClick={() => void exportSvgFile()}><Download size={15} />导出 SVG</button>}{(kind === 'image' || kind === 'spreadsheet' || kind === 'pdf') && <button className="primary" type="button" onClick={() => onSave(document, `保存${kind === 'image' ? '图片' : kind === 'spreadsheet' ? 'Excel' : 'PDF'}成果`, 'human')} disabled={!media || !hasUnsavedChanges}><Save size={15} />保存版本</button>}</div></header>{kind === 'image' && <section className="outcome-image-generator" aria-label="AI 生成图片"><header><div><strong>AI 生成图片</strong><small>仅使用主进程已持久化到当前成果媒体区的图片；不会在前端伪造文件。</small></div></header><label>图片提示词<textarea aria-label="图片生成提示词" value={prompt} onChange={(event) => setPrompt(event.target.value)} placeholder="例如：用于研究报告封面的克制蓝色数据可视化插图" disabled={isGenerating || hasUnsavedChanges} /></label><label>质量<select aria-label="图片生成质量" value={quality} onChange={(event) => setQuality(event.target.value as typeof quality)} disabled={isGenerating || hasUnsavedChanges}><option value="standard">标准</option><option value="hd">高清</option><option value="low">低</option><option value="medium">中</option><option value="high">高</option></select></label><button className="primary" type="button" onClick={() => void generate()} disabled={isGenerating || hasUnsavedChanges || !prompt.trim()}>{isGenerating ? <LoaderCircle size={15} className="spin" /> : <Sparkles size={15} />}生成图片</button>{hasUnsavedChanges && <p role="status">当前有未保存图片草稿；先保存版本后才能生成，避免覆盖编辑。</p>}{isGenerating && <p role="status">生成中。当前桥接未提供取消请求能力，不能伪称已取消。</p>}{notice && <p role="status">{notice}</p>}</section>}{!media ? <div className="outcomes-empty"><ImageIcon size={32} /><p>{kind === 'image' ? '输入提示词即可请求真实图片生成，或导入 PNG、JPEG、SVG。生成结果需手动保存为成果版本。' : kind === 'spreadsheet' ? '导入真实 XLSX 后，可在 Metis Office 中使用原生 Excel 网格编辑。' : kind === 'pdf' ? '导入真实 PDF 后，可在 Metis Office 中使用原生 PDF 页面编辑。' : '支持 PDF、PNG、JPEG 和安全 SVG；文件仅存入当前项目的成果私有媒体区。'}</p></div> : media.mediaType === 'application/pdf' && url ? <iframe title={media.displayName} className="outcome-pdf-frame" sandbox="allow-same-origin" src={url} /> : media.mediaType === 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet' ? <div className="outcome-document-file"><FileSpreadsheet size={36} /><strong>{media.displayName}</strong><span>真实 XLSX 文件已托管；点击“Metis Office”进入原生表格编辑。</span></div> : url ? <figure className="outcome-image-frame"><img src={url} alt={media.displayName} /><figcaption>{media.displayName}</figcaption></figure> : <div className="outcomes-empty">预览加载中或完整性校验未通过。</div>}</div>;
}
function VersionPanel({ versions, activeVersion, onOpen, onRestore }: { versions: OutcomeVersion[]; activeVersion: number; onOpen: (value: OutcomeVersion) => void; onRestore: (value: OutcomeVersion) => void }) {
  return <aside className="outcome-version-panel" aria-label="成果版本"><header><strong>版本</strong><span>{versions.length} 个</span></header><div>{versions.map((version) => <article key={version.version} className={version.version === activeVersion ? 'active' : ''}><button type="button" onClick={() => onOpen(version)}><b>v{version.version}</b><span>{version.note || '未填写说明'}</span><small>{version.createdBy === 'ai' ? 'AI 修改' : version.createdBy === 'restore' ? '恢复' : '人工修改'}</small></button>{version.version !== activeVersion && <button type="button" className="outcome-version-panel__restore" onClick={() => onRestore(version)} title={`恢复 v${version.version}`}><RotateCcw size={13} /></button>}</article>)}</div></aside>;
}
function OutcomeAssistant({ projectId, projectName, detail, selection, hasUnsavedChanges, historyRevision, onOpenOutcomeVersion, onLocate, onApplied, onConversationChanged }: { projectId: string; projectName: string; detail: OutcomeDetail | null; selection: AssistantSelection; hasUnsavedChanges: boolean; historyRevision: number; onOpenOutcomeVersion: (source: OutcomeSource) => void; onLocate?: (source: OutcomeSource) => void; onApplied: (applied: AssistantApplied | undefined) => void; onConversationChanged: () => void }) {
  const [messages, setMessages] = useState<ScopedMessage[]>([]);
  const [instruction, setInstruction] = useState('');
  const [isSending, setIsSending] = useState(false);
  const [notice, setNotice] = useState('');
  const [historyOpen, setHistoryOpen] = useState(false);
  // 会话单元管理：列表 / 只读浏览 / 新建与删除（桥接缺失时自动退回单历史视图）。
  const [conversations, setConversations] = useState<ConversationUnit[]>([]);
  const [browsing, setBrowsing] = useState<{ unit: ConversationUnit; messages: ScopedMessage[] } | null>(null);
  const resetOnNextLoadRef = useRef(false);
  const instructionRef = useRef<HTMLTextAreaElement>(null);
  // 任务5(2026-09-05):AI Profile 选择器——该成果绑定 Office Profile(正式持久化)。
  const [officeProfiles, setOfficeProfiles] = useState<Array<{ id: string; name: string; builtin: boolean }>>([]);
  const [boundProfileId, setBoundProfileId] = useState<string | null>(null);
  const outcomeKindForProfiles = detail?.outcome.kind === 'ppt' ? 'ppt' : 'word';
  useEffect(() => {
    let alive = true;
    void (async () => {
      try {
        const rows = await window.metis?.officePromptProfiles?.(outcomeKindForProfiles);
        if (alive && Array.isArray(rows)) setOfficeProfiles(rows.map((profile) => ({ id: profile.id, name: profile.name, builtin: profile.builtin })));
      } catch { /* profile 列表不可用时不阻塞助手 */ }
    })();
    return () => { alive = false; };
  }, [outcomeKindForProfiles]);
  useEffect(() => {
    if (!detail?.outcome.id || !window.metis?.officePromptProfiles) return;
    let alive = true;
    void (async () => {
      try {
        const rows = await window.metis?.officePromptProfiles?.(outcomeKindForProfiles);
        if (!alive || !Array.isArray(rows)) return;
        // T8 假配置修复：binding 从 office_prompt_outcome_bindings 表读取真值回显。
        const boundId = await window.metis?.officePromptGetBinding?.(detail.outcome.id);
        if (alive && typeof boundId === 'string' && boundId) setBoundProfileId(boundId);
      } catch { /* best-effort */ }
    })();
    return () => { alive = false; };
  }, [detail?.outcome.id, outcomeKindForProfiles]);
  // 指令框随内容自动增高，最多约 10 行，超出后内部滚动。
  useEffect(() => {
    if (instructionRef.current) autoResizeTextarea(instructionRef.current);
  }, [instruction]);
  const outcomeId = detail?.outcome.id;
  useEffect(() => {
    if (!historyOpen) return;
    const onKey = (event: KeyboardEvent) => { if (event.key === 'Escape') { event.stopPropagation(); setHistoryOpen(false); } };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [historyOpen]);

  useEffect(() => {
    let current = true;
    if (!outcomeId || !window.metis) { void Promise.resolve().then(() => { if (current) setMessages([]); }); return () => { current = false; }; }
    void window.metis.listScopedConversation({ projectId, scope: 'outcome', outcomeId, scenarioId: null })
      .then((rows) => {
        if (!current) return;
        const next = (rows ?? []) as ScopedMessage[];
        // 新建/删除会话后，主面板必须以最新会话为准整体替换，而不是合并旧记录。
        if (resetOnNextLoadRef.current) { resetOnNextLoadRef.current = false; setMessages(next); }
        else setMessages((previous) => mergeMessages(previous, next));
      });
    return () => { current = false; };
  }, [historyRevision, outcomeId, projectId]);

  const loadConversations = useCallback(async () => {
    const units = assistantBridge()?.outcomesConversationUnits;
    if (!units || !outcomeId) { setConversations([]); return; }
    try { setConversations((await units({ projectId, outcomeId })) ?? []); } catch { setConversations([]); }
  }, [outcomeId, projectId]);

  useEffect(() => {
    let current = true;
    void Promise.resolve().then(() => { if (current) return loadConversations(); });
    return () => { current = false; };
  }, [loadConversations, historyRevision]);

  const startNewConversation = async () => {
    const create = assistantBridge()?.outcomesConversationCreate;
    if (!create || !detail || isSending) return;
    try {
      const created = await create({ projectId, outcomeId: detail.outcome.id });
      if (!created?.id) { setNotice('未能新建对话；当前协作历史保持不变。'); return; }
      // 新会话立即成为持久化目标（仓储按最近更新选择）；本地同步清空等待第一条消息。
      setMessages([]);
      setBrowsing(null);
      resetOnNextLoadRef.current = true;
      await loadConversations();
      onConversationChanged();
    } catch { setNotice('新建对话未完成；当前协作历史保持不变。'); }
  };

  const removeConversation = async (unitId: string) => {
    const remove = assistantBridge()?.outcomesConversationDelete;
    if (!remove || !detail || isSending) return;
    try {
      const removed = await remove({ projectId, conversationId: unitId });
      if (!removed) { setNotice('删除未完成：该会话不存在或不属于当前项目。'); return; }
      setBrowsing((current) => (current?.unit.id === unitId ? null : current));
      resetOnNextLoadRef.current = true;
      await loadConversations();
      onConversationChanged();
    } catch { setNotice('删除未完成，请重试。'); }
  };

  const browseConversation = async (unit: ConversationUnit) => {
    const byId = assistantBridge()?.outcomesConversationById;
    if (!byId || isSending) return;
    try {
      const rows = ((await byId({ projectId, conversationId: unit.id })) ?? []) as ScopedMessage[];
      setBrowsing({ unit, messages: rows });
    } catch { setNotice('无法载入该会话的记录。'); }
  };

  const send = async () => {
    if (!detail || !instruction.trim() || isSending) return;
    if (hasUnsavedChanges) { setNotice('当前成果有未保存的编辑。请先保存为新版本，再让 AI 协同，避免覆盖本地草稿。'); return; }
    const chat = assistantBridge()?.chatOutcomeAssistant;
    if (!chat) { setNotice('成果 AI 运行服务尚未就绪，未发送也未创建任何修改。'); return; }
    setIsSending(true); setNotice('');
    try {
      const scopedSelection = requestSelection(selection);
      const result: AssistantResult = await chat({ projectId, outcomeId: detail.outcome.id, instruction: instruction.trim(), ...(scopedSelection ? { selection: scopedSelection } : {}) });
      setInstruction('');
      if (result.status === 'completed') {
        setMessages((previous) => mergeMessages(previous, [result.userMessage, result.assistantMessage]));
        onConversationChanged();
        if (result.applied) { onApplied(result.applied); setNotice('AI 已将经过校验的修改保存为新版本；你可在版本面板随时回退。'); }
        else setNotice('AI 已回复。本轮没有生成可安全应用的结构化修改，因此成果内容未被改动。');
        return;
      }
      const failed = result as unknown as { status: 'error' | 'cancelled'; code?: string; message?: string; userMessage?: ScopedMessage };
      setMessages((previous) => mergeMessages(previous, [failed.userMessage]));
      if (failed.userMessage) onConversationChanged();
      setNotice(failed.message || `本次协同未完成：${failed.code || failed.status}`);
    } catch { setNotice('成果 AI 请求没有完成，成果内容没有被修改。'); }
    finally { setIsSending(false); }
  };

  return <aside className="outcome-assistant" aria-label="AI 成果助手">
    <header className="outcome-assistant__header"><span className="outcome-assistant__mark"><Sparkles size={16} /></span><div><h2>AI 成果助手</h2><p>项目《{projectName}》</p></div><button type="button" className="outcome-assistant__history-btn" onClick={() => setHistoryOpen(true)} disabled={!detail} title={detail ? '查看成果协作历史' : '先打开一个成果，即可查看与它的协作历史'} aria-label="查看成果协作历史"><History size={15} />历史记录</button></header>
    {detail && officeProfiles.length > 0 && (
      <div className="outcome-assistant__profile-row" aria-label="AI Profile">
        <span>AI Profile</span>
        <select
          aria-label="选择 AI Profile"
          value={boundProfileId ?? ''}
          onChange={(event) => {
            const profileId = event.target.value || null;
            setBoundProfileId(profileId);
            void window.metis?.officePromptBindOutcome?.({ outcomeId: detail.outcome.id, profileId });
          }}
          data-testid="assistant-profile-select"
        >
          <option value="">格式默认</option>
          {officeProfiles.map((profile) => <option key={profile.id} value={profile.id}>{profile.name}{profile.builtin ? '(内置)' : ''}</option>)}
        </select>
      </div>
    )}
    {!detail ? <div className="outcome-assistant__empty"><Bot size={24} /><h3>打开成果后开始协作</h3><p>助手仅绑定当前项目和成果；实际使用的资料会逐条显示在协作记录下方。</p></div> : <>
      <section className="outcome-assistant__context" aria-label="当前上下文">
        <strong>当前上下文</strong>
        <ul><li>项目：{projectName}</li><li>成果：{detail.outcome.title}</li><li>版本：v{detail.version.version}</li><li><span>选区：</span><span>{selectionContextLabel(selection)}</span>{selectedCharacterCount(selection) !== undefined && <span>，<b>已选 {selectedCharacterCount(selection)} 个字符</b></span>}</li></ul>
        <p>这里只显示当前状态；每轮实际使用的资料以对应协作记录为准。</p>
      </section>
      <div className="outcome-assistant__messages" aria-live="polite">
        {messages.length === 0 ? <div className="outcome-assistant__starter"><p>可以直接说：</p><button type="button" onClick={() => setInstruction('检查当前成果的结构、论证和表达问题，并给出可直接应用的修改。')}>检查当前成果</button><button type="button" onClick={() => setInstruction('根据当前项目已有资料，改进当前选中的内容。')}>根据项目资料修改</button></div> : messages.slice(-8).map((message) => <article key={message.id} className={`outcome-assistant__message outcome-assistant__message--${message.role}`} aria-label={`${message.role === 'user' ? '用户' : message.role === 'assistant' ? 'METIS' : '系统'}协作记录`}><span>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'METIS' : '系统'}</span><p>{message.content}</p><OutcomeSourceList sources={message.sources} label="本条实际来源" onOpenOutcomeVersion={onOpenOutcomeVersion} onLocate={onLocate} /></article>)}
      </div>
      {notice && <p className="outcome-assistant__notice" role="status">{notice}</p>}
      <div className="outcome-assistant__composer"><textarea ref={instructionRef} value={instruction} onChange={(event) => setInstruction(event.target.value)} onKeyDown={(event) => { if (event.key === 'Enter' && (event.ctrlKey || event.metaKey)) { event.preventDefault(); void send(); } }} placeholder="例如：根据项目中的实验结果重写当前段落" disabled={isSending} /><div className="outcome-assistant__composer-tools" data-testid="outcome-assistant-toolbar"><ModelThinkingSelector zh={true} disabled={isSending} /><span style={{ flex: 1 }} /><span>Ctrl / ⌘ + Enter 发送</span><button className="primary" type="button" onClick={() => void send()} disabled={isSending || !instruction.trim()}>{isSending ? <LoaderCircle size={15} className="spin" /> : <Send size={15} />}发送</button></div></div>
    </>}
    {historyOpen && detail && <ConversationHistoryDialog messages={messages} title={`${detail.outcome.title} · 协作历史`} close={() => setHistoryOpen(false)} onOpenOutcomeVersion={onOpenOutcomeVersion} onLocate={onLocate} conversations={conversations} browsing={browsing} managementAvailable={Boolean(assistantBridge()?.outcomesConversationCreate && assistantBridge()?.outcomesConversationDelete)} onBrowse={(unit) => void browseConversation(unit)} onBackToCurrent={() => setBrowsing(null)} onNewConversation={() => void startNewConversation()} onDeleteConversation={(unitId) => void removeConversation(unitId)} />}
  </aside>;
}
function ConversationHistoryDialog({ messages, title, close, onOpenOutcomeVersion, onLocate, conversations, browsing, managementAvailable, onBrowse, onBackToCurrent, onNewConversation, onDeleteConversation }: { messages: ScopedMessage[]; title: string; close: () => void; onOpenOutcomeVersion: (source: OutcomeSource) => void; onLocate?: (source: OutcomeSource) => void; conversations: ConversationUnit[]; browsing: { unit: ConversationUnit; messages: ScopedMessage[] } | null; managementAvailable: boolean; onBrowse: (unit: ConversationUnit) => void; onBackToCurrent: () => void; onNewConversation: () => void; onDeleteConversation: (unitId: string) => void }) {
  const visible = browsing ? browsing.messages : messages;
  return <div className="outcomes-modal-backdrop" role="presentation"><section className="outcomes-modal outcome-history-dialog" role="dialog" aria-modal="true" aria-label="成果协作历史"><header><div><strong>{title}</strong><small>历史由当前项目与成果共同保存；每条记录仅展示其持久化的实际来源。</small></div><button type="button" onClick={close} aria-label="关闭"><X size={16} /></button></header>
    {managementAvailable && <div className="outcome-history-dialog__manager">
      <div className="outcome-history-dialog__toolbar"><button type="button" className="primary" onClick={onNewConversation}><Plus size={13} />新对话</button><small>发送下一条消息时会保存到最新对话；删除仅移除所选对话。</small></div>
      {conversations.length > 0 && <ul className="outcome-history-dialog__units">
        {conversations.map((unit, index) => <li key={unit.id} className={browsing?.unit.id === unit.id ? 'active' : ''}>
          <button type="button" onClick={() => onBrowse(unit)} aria-label={`查看对话 ${unit.title || '未命名对话'}`}>
            <b>{index === 0 ? '当前 · ' : ''}{unit.title || '未命名对话'}</b>
            <span>{new Date(unit.updatedAt).toLocaleString()} · {unit.messageCount} 条</span>
          </button>
          <button type="button" onClick={() => onDeleteConversation(unit.id)} aria-label={`删除对话 ${unit.title || '未命名对话'}`} title="删除该对话"><Trash2 size={13} /></button>
        </li>)}
      </ul>}
    </div>}
    <p className="outcome-history-dialog__scope">{browsing ? `正在查看历史对话「${browsing.unit.title || '未命名对话'}」（只读）。` : '以下为当前对话记录。'}</p>
    <div className="outcome-history-dialog__messages">{visible.length === 0 ? <p>{browsing ? '该会话没有已保存的记录。' : '还没有已保存的协作记录。'}</p> : visible.map((message) => <article key={message.id}><b>{message.role === 'user' ? '你' : message.role === 'assistant' ? 'METIS' : '系统'}</b><time>{new Date(message.createdAt).toLocaleString()}</time><p>{message.content}</p><OutcomeSourceList sources={message.sources} label="本条实际来源" onOpenOutcomeVersion={onOpenOutcomeVersion} onLocate={onLocate} /></article>)}</div><footer>{browsing && <button type="button" onClick={onBackToCurrent}>返回当前对话</button>}<button className="primary" type="button" onClick={close}>返回成果助手继续协作</button></footer></section></div>;
}
