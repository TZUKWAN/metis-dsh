/**
 * ProjectsPage — 科研项目工作台。
 *
 * 科研项目（原「研究写作」）的新形态：左侧直接展示科研项目列表，
 * 主区域为三个模式页签：聊天 / 任务看板 / 资料。
 * 九分区（项目设计/资料来源/…）按产品决定暂不暴露。
 *
 * 聊天内容由 App 层常驻的 ChatPage 提供（renderLayout 注入），
 * 因此切换模式或导航不会丢失对话草稿。
 */
import { useCallback, useEffect, useRef, useState, type ReactNode } from 'react';
import { useTranslation } from '../i18n';
import { FolderPlus } from 'lucide-react';
import { researchWorkspaceStore, useResearchWorkspaceStore } from '../research/researchWorkspaceStore';

import { Button, Input, Select } from '../components/ui';
import ConfirmDialog from '../components/ConfirmDialog';
import { EmptyState, InlineError, OperationNotice, QuietLoading, RowActionsMenu, StaleDataNotice, type OperationNoticeState } from '../components/async/AsyncFeedback';
import { usePendingAction } from '../components/async/asyncViewState';
import { usePersistentScroll } from '../hooks/workspacePersistence';
import LibraryPage from './LibraryPage';
import { ProjectMaterialsPanel } from './ProjectMaterialsPanel';
import ProjectHomeBanner from '../components/ProjectHomeBanner';
import SplitHandle from '../components/SplitHandle';

export type ProjectViewMode = 'chat' | 'kanban' | 'materials';

export interface ProjectsPageProps {
  /** Active project-center mode (controlled by the app shell). */
  mode: ProjectViewMode;
  onModeChange: (mode: ProjectViewMode) => void;
  /** Chat workspace content — owned by the app-level ChatPage. */
  chatContent: ReactNode;
  /** Chat right panel — owned by the app-level ChatPage. */
  chatRightPanel: ReactNode;
  /** 生成物预览栏（2026-08-31 刘总布局重构）：非空即在最右侧以整列呈现，
   *  并联动：项目清单自动收缩、聊天区弹性让位（窗口缩放自适应）。 */
  previewPanel?: ReactNode;
}

const MODES: Array<{ id: ProjectViewMode; labelKey: string; testId: string }> = [
  { id: 'chat', labelKey: 'projects.modeChat', testId: 'projects-mode-chat' },
  // 任务看板页签按刘总要求移除（2026-09）；ProjectViewMode 仍保留 'kanban'
  // 以兼容旧持久化值，渲染时按 chat 处理。
  { id: 'materials', labelKey: 'projects.modeMaterials', testId: 'projects-mode-materials' },
];

function makeProjectId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `project-${crypto.randomUUID()}`;
    }
  } catch {
    // Fall through to a bounded renderer-only identifier.
  }
  return `project-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

const SIDEBAR_KEY = 'metis-projects-sidebar-width';
const CHAT_RIGHT_KEY = 'metis-projects-chat-right-width';
const PREVIEW_KEY = 'metis-projects-preview-width';
const SIDEBAR_COLLAPSED_KEY = 'metis-projects-sidebar-collapsed';

function loadWidth(key: string, fallback: number, min: number, max: number): number {
  try {
    const raw = window.localStorage.getItem(key);
    const value = raw === null ? NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(max, Math.max(min, value)) : fallback;
  } catch {
    return fallback;
  }
}

function saveWidth(key: string, value: number): void {
  try { window.localStorage.setItem(key, String(Math.round(value))); } catch { /* best-effort */ }
}

function loadBool(key: string, fallback: boolean): boolean {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? fallback : raw === '1';
  } catch {
    return fallback;
  }
}

function formatUpdated(ts: number, locale: string): string {
  const date = new Date(ts);
  const now = Date.now();
  const diffDays = Math.floor((now - ts) / 86_400_000);
  if (diffDays <= 0) return locale === 'zh' ? '今天' : 'today';
  if (diffDays === 1) return locale === 'zh' ? '昨天' : 'yesterday';
  const y = date.getFullYear();
  const m = String(date.getMonth() + 1).padStart(2, '0');
  const d = String(date.getDate()).padStart(2, '0');
  return `${y}-${m}-${d}`;
}

export default function ProjectsPage({ mode, onModeChange, chatContent, chatRightPanel, previewPanel }: ProjectsPageProps) {
  const { t, locale } = useTranslation();
  const projects = useResearchWorkspaceStore((s) => s.projects);
  const activeProjectId = useResearchWorkspaceStore((s) => s.activeProjectId);
  const loadingProjects = useResearchWorkspaceStore((s) => s.loading.projects);
  // 任务4：消费 store 的结构化错误与 stale 标记——加载失败不再冒充空列表。
  const loadError = useResearchWorkspaceStore((s) => s.error);
  const projectsStale = useResearchWorkspaceStore((s) => s.projectsStale);
  const [creating, setCreating] = useState(false);
  const [newTitle, setNewTitle] = useState('');
  const [projectDir, setProjectDir] = useState('');
  // 新建项目绑定场景（2026-08-29 刘总要求）：科研项目页的内联创建表单
  // 同样提供场景下拉；创建后写入全局与项目级偏好。
  const [createScenarioOptions, setCreateScenarioOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [createScenarioId, setCreateScenarioId] = useState('');
  const [createBusy, setCreateBusy] = useState(false);
  const [sidebarWidth, setSidebarWidth] = useState(() => loadWidth(SIDEBAR_KEY, 248, 180, 420));
  const [chatRightWidth, setChatRightWidth] = useState(() => loadWidth(CHAT_RIGHT_KEY, 320, 240, 560));
  // 预览栏与项目清单折叠（2026-08-31 刘总布局重构）：预览打开时清单自动
  // 收缩，给预览留足空间；手动拖拽调宽全部保留。
  const [previewWidth, setPreviewWidth] = useState(() => loadWidth(PREVIEW_KEY, 520, 360, 800));
  const [sidebarCollapsed, setSidebarCollapsed] = useState(() => loadBool(SIDEBAR_COLLAPSED_KEY, false));
  const [showArchived, setShowArchived] = useState(false);
  // ── 行内操作（任务4 第五/六节）：归档/恢复/删除收进 ···，防双击 + 失败可见 ──
  const rowAction = usePendingAction();
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; title: string } | null>(null);
  const pageRef = useRef<HTMLDivElement>(null);
  const [deleteBusy, setDeleteBusy] = useState(false);
  const [sidebarNotice, setSidebarNotice] = useState<OperationNoticeState | null>(null);
  // 项目清单滚动位置保持（任务4 第十一节）：切走再回来不重置。
  const sidebarScroll = usePersistentScroll<HTMLUListElement>('metis-projects-sidebar-scroll', showArchived ? 'archived' : 'active');
  // ── 多对话架构第二期(2026-09-05):Project → Conversation 树 ──
  const [projectSessions, setProjectSessions] = useState<Array<{ id: string; title: string; lastActivity: number; messageCount: number }>>([]);
  const activeTreeProjectId = showArchived ? null : activeProjectId;
  useEffect(() => {
    let alive = true;
    if (!activeTreeProjectId || !window.metis?.listSessions) {
      setProjectSessions([]);
      return () => { alive = false; };
    }
    void window.metis.listSessions({ projectId: activeTreeProjectId }).then((payload) => {
      if (!alive) return;
      const items = (payload?.sessions ?? []) as Array<{ id: string; title?: string; lastActivity: number; messageCount: number; archived?: boolean }>;
      setProjectSessions(items.filter((item) => !item.archived).map((item) => ({
        id: item.id,
        title: item.title || '新对话',
        lastActivity: item.lastActivity,
        messageCount: item.messageCount,
      })));
    }).catch(() => { if (alive) setProjectSessions([]); });
  }, [activeTreeProjectId, showArchived]);
  const collapsedBeforePreviewRef = useRef<boolean | null>(null);
  const sidebarCollapsedRef = useRef(sidebarCollapsed);
  sidebarCollapsedRef.current = sidebarCollapsed;

  const previewOpen = Boolean(previewPanel);

  // ── 归档/恢复（可逆操作）：防双击；失败给出可见提示，成功静默刷新 ──
  const handleArchive = useCallback((projectId: string) => {
    void rowAction.run(async () => {
      try {
        const result = await window.metis?.archiveProject?.(projectId);
        if (!result?.ok) {
          setSidebarNotice({ kind: 'error', text: locale === 'zh' ? '归档未完成，项目仍在原列表，可直接重试。' : 'Archive did not complete. The project is unchanged; you can retry.' });
          return;
        }
        if (researchWorkspaceStore.getState().activeProjectId === projectId) {
          await researchWorkspaceStore.getState().setActiveProject(null);
        }
        await researchWorkspaceStore.getState().loadProjects();
      } catch (error) {
        console.error('[ProjectsPage] archiveProject failed:', error);
        setSidebarNotice({ kind: 'error', text: locale === 'zh' ? '归档未完成，项目仍在原列表，可直接重试。' : 'Archive did not complete. The project is unchanged; you can retry.' });
      }
    });
  }, [rowAction, locale]);

  const handleRestore = useCallback((projectId: string) => {
    void rowAction.run(async () => {
      try {
        const result = await window.metis?.restoreProject?.(projectId);
        if (!result?.ok) {
          setSidebarNotice({ kind: 'error', text: locale === 'zh' ? '恢复未完成，项目仍在归档列表，可直接重试。' : 'Restore did not complete. The project is still archived; you can retry.' });
          return;
        }
        await researchWorkspaceStore.getState().loadProjects();
      } catch (error) {
        console.error('[ProjectsPage] restoreProject failed:', error);
        setSidebarNotice({ kind: 'error', text: locale === 'zh' ? '恢复未完成，项目仍在归档列表，可直接重试。' : 'Restore did not complete. The project is still archived; you can retry.' });
      }
    });
  }, [rowAction, locale]);

  // ── 删除（软删除，可经项目侧栏「回收站」恢复）：结构化确认 + busy 防双击 ──
  const confirmDelete = useCallback(async () => {
    if (!deleteTarget) return;
    setDeleteBusy(true);
    try {
      const result = await window.metis?.deleteProject?.(deleteTarget.id);
      if (!result?.ok) {
        // IPC 缺失或主进程未执行删除（ok:false）→ 数据未动，如实告知。
        setSidebarNotice({ kind: 'error', text: locale === 'zh' ? '删除未完成，项目未被改动，可直接重试。' : 'Delete did not complete. The project is unchanged; you can retry.' });
        return;
      }
      if (researchWorkspaceStore.getState().activeProjectId === deleteTarget.id) {
        await researchWorkspaceStore.getState().setActiveProject(null);
      }
      await researchWorkspaceStore.getState().loadProjects();
      setSidebarNotice({ kind: 'success', text: locale === 'zh' ? `「${deleteTarget.title}」已移入回收站，可在项目侧栏「回收站」恢复。` : `“${deleteTarget.title}” moved to the recycle bin. Restore it from the sidebar Recycle Bin.` });
      setDeleteTarget(null);
    } catch (error) {
      console.error('[ProjectsPage] deleteProject failed:', error);
      setSidebarNotice({ kind: 'error', text: locale === 'zh' ? '删除未完成，项目未被改动，可直接重试。' : 'Delete did not complete. The project is unchanged; you can retry.' });
    } finally {
      setDeleteBusy(false);
    }
  }, [deleteTarget, locale]);

  const handleSidebarDrag = useCallback((clientX: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setSidebarWidth(Math.min(420, Math.max(180, clientX - rect.left)));
  }, []);

  const handleChatRightDrag = useCallback((clientX: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setChatRightWidth(Math.min(560, Math.max(240, rect.right - clientX)));
  }, []);

  const handlePreviewDrag = useCallback((clientX: number) => {
    const rect = pageRef.current?.getBoundingClientRect();
    if (!rect) return;
    setPreviewWidth(Math.min(800, Math.max(360, rect.right - clientX)));
  }, []);

  // 预览开合联动（2026-08-31 刘总要求，窗口缩放自适应修正）：打开时项目清单
  // 自动收缩（记住打开前的折叠态，关闭时恢复）。聊天区保持 flex:1 弹性填充
  // ——预览栏（固定像素、可拖宽）之外的剩余空间全部归聊天区，窗口放大/缩小
  // 时 flex 自动重排，不再出现"打开预览后窗口变大留下大片空白"的问题。
  // 此前实现是预览打开瞬间实测聊天宽度钉成固定像素（flex:none），窗口尺寸
  // 变化后没有任何列跟随伸缩。
  useEffect(() => {
    if (previewOpen) {
      if (collapsedBeforePreviewRef.current === null) {
        collapsedBeforePreviewRef.current = sidebarCollapsedRef.current;
        setSidebarCollapsed(true);
      }
      return;
    }
    if (collapsedBeforePreviewRef.current !== null) {
      setSidebarCollapsed(collapsedBeforePreviewRef.current);
      collapsedBeforePreviewRef.current = null;
    }
  }, [previewOpen]);

  // 宽度持久化放 effect：拖动结束时读到的是最新值。
  useEffect(() => { saveWidth(SIDEBAR_KEY, sidebarWidth); }, [sidebarWidth]);
  useEffect(() => { saveWidth(CHAT_RIGHT_KEY, chatRightWidth); }, [chatRightWidth]);
  useEffect(() => { saveWidth(PREVIEW_KEY, previewWidth); }, [previewWidth]);
  useEffect(() => {
    try { window.localStorage.setItem(SIDEBAR_COLLAPSED_KEY, sidebarCollapsed ? '1' : '0'); } catch { /* best-effort */ }
  }, [sidebarCollapsed]);

  useEffect(() => {
    void researchWorkspaceStore.getState().loadProjects();
  }, []);

  // 展开创建表单时加载可选场景清单。
  useEffect(() => {
    if (!creating) return;
    const metis = window.metis;
    if (!metis?.listPersonalization) { setCreateScenarioOptions([]); return; }
    void metis.listPersonalization({ contractVersion: 1, kind: 'scenario', includeDisabled: false })
      .then((response) => {
        setCreateScenarioOptions(response.definitions
          .filter((definition) => definition.kind === 'scenario'
            && definition.enabled
            && definition.provenance.origin !== 'builtin')
          .map((definition) => ({ id: definition.id, name: definition.name })));
      })
      .catch(() => setCreateScenarioOptions([]));
  }, [creating]);

  const handleCreate = async () => {
    const title = newTitle.trim();
    if (!title || createBusy) return;
    setCreateBusy(true);
    const result = await researchWorkspaceStore.getState().createProject({
      projectId: makeProjectId(),
      title,
    });
    if (!result.success) {
      // 任务4：创建失败必须可见（此前静默），标题保留以便直接重试。
      setCreateBusy(false);
      setSidebarNotice({
        kind: 'error',
        text: locale === 'zh' ? '项目创建未完成，标题已保留，可直接重试。' : 'Project creation did not complete. The title is kept; you can retry.',
        ...(result.code ? { code: result.code } : {}),
      });
      return;
    }
    const newProjectId = result.resourceId ?? null;
    // 创建后若指定了自定义目录，写入 metadata.projectDir（PDF 归档位置）。
    // 次级偏好写入失败不阻塞项目创建本身，但必须提示而非静默。
    try {
      if (projectDir && newProjectId) {
        const dirResult = await window.metis?.setProjectDir?.(newProjectId, projectDir);
        if (dirResult && dirResult.ok === false) {
          setSidebarNotice({ kind: 'error', text: locale === 'zh' ? '项目已创建，但自定义目录设置未完成，可在稍后重试。' : 'Project created, but setting the custom folder failed. You can retry later.' });
        }
      }
      if (createScenarioId && newProjectId) {
        // 多对话架构(2026-09-04):默认场景正式持久化到项目(defaultScenarioId);
        // legacy localStorage 仅作兼容残留(读取路径会自动迁移并清理)。
        await window.metis?.setDefaultScenario?.(newProjectId, createScenarioId);
        try {
          window.localStorage.setItem('metis:active-scenario-id', createScenarioId);
          window.localStorage.setItem(`metis:project-scenario:${newProjectId}`, createScenarioId);
        } catch { /* preference persistence is best-effort */ }
      }
    } catch (error) {
      console.error('[ProjectsPage] post-create preference write failed:', error);
      setSidebarNotice({ kind: 'error', text: locale === 'zh' ? '项目已创建，但部分偏好设置未保存。' : 'Project created, but some preferences were not saved.' });
    }
    setCreateBusy(false);
    if (result.success) {
      setNewTitle('');
      setProjectDir('');
      setCreateScenarioId('');
      setCreating(false);
      // 任务4 第十二节：新建后 focus 主输入区——聚焦新项目条目，
      // 让键盘用户立刻感知创建结果并可直接 Enter 进入。
      requestAnimationFrame(() => {
        const row = newProjectId
          ? document.querySelector<HTMLElement>(`[data-project-id="${newProjectId}"]`)
          : null;
        row?.focus();
      });
    }
  };

  const pickProjectDir = async () => {
    const picked = await window.metis?.openDirectoryDialog?.();
    if (picked) setProjectDir(picked);
  };

  return (
    <div className="projects-page" data-testid="projects-page" ref={pageRef}>
      {sidebarCollapsed ? (
        <div className="projects-page__sidebar-rail" data-testid="projects-sidebar-rail">
          <button
            type="button"
            className="projects-page__rail-btn"
            title={locale === 'zh' ? '展开项目清单' : 'Expand project list'}
            aria-label={locale === 'zh' ? '展开项目清单' : 'Expand project list'}
            data-testid="projects-sidebar-expand"
            onClick={() => setSidebarCollapsed(false)}
          >
            »
          </button>
        </div>
      ) : (
      <aside
        className="projects-page__sidebar"
        aria-label={t('projects.projectListTitle')}
        style={{ width: sidebarWidth }}
      >
        <header className="projects-page__sidebar-header">
          <h2>{t('projects.projectListTitle')}</h2>
          <button
            type="button"
            className="projects-page__collapse-btn"
            title={locale === 'zh' ? '收起项目清单' : 'Collapse project list'}
            aria-label={locale === 'zh' ? '收起项目清单' : 'Collapse project list'}
            data-testid="projects-sidebar-collapse"
            onClick={() => setSidebarCollapsed(true)}
          >
            «
          </button>
          <Button
            variant="secondary"
            size="sm"
            className="projects-page__new"
            data-testid="projects-new-project"
            onClick={() => setCreating((value) => !value)}
          >
            {t('projects.newProject')}
          </Button>
          <Button
            variant={showArchived ? 'primary' : 'secondary'}
            size="sm"
            className="projects-page__new"
            title={t('projects.archivedTitle')}
            data-testid="projects-toggle-archived"
            onClick={() => setShowArchived((value) => !value)}
          >
            {showArchived ? t('projects.activeTitle') : t('projects.archivedButton')}
          </Button>
        </header>
        {creating && (
          <div className="projects-page__create" data-testid="projects-create-form">
            <Input
              className="settings-input"
              data-testid="projects-new-project-input"
              value={newTitle}
              placeholder={t('projects.newProjectPlaceholder')}
              onChange={(event) => setNewTitle(event.target.value)}
              onKeyDown={(event) => {
                if (event.key === 'Enter') void handleCreate();
                if (event.key === 'Escape') { setCreating(false); setNewTitle(''); }
              }}
            />
            <Select
              className="settings-input"
              data-testid="projects-scenario-select"
              value={createScenarioId}
              onChange={(event) => setCreateScenarioId(event.target.value)}
              aria-label={t('projects.scenarioBinding')}
            >
              <option value="">{t('projects.scenarioNone')}</option>
              {createScenarioOptions.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
              ))}
            </Select>
            <div className="projects-page__create-actions">
              <Button
                variant="primary"
                size="sm"
                data-testid="projects-create-submit"
                disabled={createBusy || !newTitle.trim()}
                onClick={() => void handleCreate()}
              >
                {t('projects.create')}
              </Button>
              <Button
                variant="secondary"
                size="sm"
                onClick={() => { setCreating(false); setNewTitle(''); setProjectDir(''); }}
              >
                {t('projects.cancel')}
              </Button>
            </div>
            <div className="projects-page__create-dir" data-testid="projects-create-dir">
              <Input
                className="settings-input"
                placeholder={t('projects.projectDirPlaceholder')}
                value={projectDir}
                onChange={(event) => setProjectDir(event.target.value)}
                data-testid="projects-dir-input"
              />
              <Button
                variant="secondary"
                size="sm"
                onClick={() => void pickProjectDir()}
                data-testid="projects-dir-browse"
              >
                {t('projects.browse')}
              </Button>
            </div>
            <p className="projects-page__create-hint">{t('projects.projectDirHint')}</p>
          </div>
        )}
        <ul className="projects-page__list" ref={sidebarScroll.ref}>
          {projectsStale && !loadingProjects && (
            <li>
              <StaleDataNotice
                onRetry={() => void researchWorkspaceStore.getState().loadProjects()}
                code={loadError?.code}
              />
            </li>
          )}
          {sidebarNotice && (
            <li>
              <OperationNotice notice={sidebarNotice} onClear={() => setSidebarNotice(null)} />
            </li>
          )}
          {projects
            .filter((project) => (showArchived ? project.lifecycle === 'archived' : project.lifecycle !== 'archived'))
            .map((project) => (
              <li key={project.id} className="projects-page__item-row">
                <button
                  type="button"
                  className={`projects-page__item ${activeProjectId === project.id ? 'active' : ''}`}
                  data-testid="projects-project-item"
                  data-project-id={project.id}
                  aria-current={activeProjectId === project.id ? 'page' : undefined}
                  onClick={() => void researchWorkspaceStore.getState().setActiveProject(project.id)}
                >
                  <span className="projects-page__item-title">{project.title}</span>
                  <span className="projects-page__item-meta">
                    {showArchived
                      ? t('projects.archivedAt', { time: formatUpdated(project.archivedAt ?? project.updatedAt, locale) })
                      : t('projects.projectUpdated', { time: formatUpdated(project.updatedAt, locale) })}
                  </span>
                </button>
                {/* 归档/删除等低频操作收进 ···（任务4 第六节），不再常驻行内。 */}
                <div className="projects-page__item-actions">
                  <RowActionsMenu
                    label={locale === 'zh' ? `项目「${project.title}」的更多操作` : `More actions for ${project.title}`}
                    testId="projects-row-menu"
                    items={[
                      showArchived
                        ? {
                            id: 'restore',
                            label: t('projects.restore'),
                            disabled: rowAction.pending,
                            onSelect: () => handleRestore(project.id),
                          }
                        : {
                            id: 'archive',
                            label: t('projects.archive'),
                            disabled: rowAction.pending,
                            onSelect: () => handleArchive(project.id),
                          },
                      {
                        id: 'delete',
                        label: t('projects.delete'),
                        danger: true,
                        disabled: rowAction.pending,
                        onSelect: () => setDeleteTarget({ id: project.id, title: project.title }),
                      },
                    ]}
                  />
                </div>
                {activeProjectId === project.id && !showArchived && (
                  <div className="projects-page__conversations" data-testid="projects-conversation-tree">
                    {projectSessions.map((session) => (
                      <button
                        key={session.id}
                        type="button"
                        className="projects-page__conversation"
                        data-testid={`projects-conversation-${session.id}`}
                        onClick={() => {
                          void researchWorkspaceStore.getState().setActiveProject(project.id).then(() => {
                            onModeChange('chat');
                            window.dispatchEvent(new CustomEvent('metis:switch-session', { detail: { sessionId: session.id } }));
                          });
                        }}
                      >
                        <span className="projects-page__conversation-title">{session.title}</span>
                        <span className="projects-page__conversation-meta">{session.messageCount}</span>
                      </button>
                    ))}
                    {projectSessions.length === 0 && (
                      <span className="projects-page__conversation-empty">还没有对话——切到「聊天」页签即可开始。</span>
                    )}
                  </div>
                )}
              </li>
            ))}
          {loadingProjects && projects.length === 0 && (
            <li><QuietLoading compact label={locale === 'zh' ? '正在加载项目…' : 'Loading projects…'} /></li>
          )}
          {/* 任务4：首次加载失败 ≠ 空列表。error 可重试，empty 给用途 + 第一动作。 */}
          {!loadingProjects && loadError && projects.length === 0 && (
            <li>
              <InlineError
                title={locale === 'zh' ? '项目列表加载失败。' : 'Could not load the project list.'}
                hint={locale === 'zh' ? '项目数据没有丢失，只是暂时读不到。' : 'Your projects are safe; they just could not be read right now.'}
                code={loadError.code}
                compact
                retrying={false}
                onRetry={() => void researchWorkspaceStore.getState().loadProjects()}
              />
            </li>
          )}
          {!loadingProjects && !loadError && projects.filter((project) => (showArchived ? project.lifecycle === 'archived' : project.lifecycle !== 'archived')).length === 0 && (
            <li className="projects-page__empty">
              <EmptyState
                compact
                icon={<FolderPlus size={20} />}
                title={showArchived ? t('projects.noArchived') : t('projects.emptyProjects')}
                description={showArchived
                  ? (locale === 'zh' ? '归档的项目会显示在这里，可随时恢复。' : 'Archived projects will appear here and can be restored anytime.')
                  : (locale === 'zh' ? '项目是研究的家：聊天、任务、资料与成果都在项目里组织。' : 'A project is home to your chat, tasks, materials, and outcomes.')}
                action={!showArchived && (
                  <Button variant="secondary" size="sm" data-testid="projects-empty-create" onClick={() => setCreating(true)}>
                    {t('projects.newProject')}
                  </Button>
                )}
              />
            </li>
          )}
        </ul>
      </aside>
      )}

      {!sidebarCollapsed && (
      <SplitHandle
        label={locale === 'zh' ? '拖动调整项目列表宽度' : 'Drag to resize the project list'}
        testId="projects-split-sidebar"
        onDrag={handleSidebarDrag}
        onKeyDelta={(delta) => {
          setSidebarWidth((current) => Math.min(420, Math.max(180, current + delta)));
        }}
      />
      )}

      <div className="projects-page__main">
        {activeProjectId ? <ProjectHomeBanner /> : (
          !loadingProjects && projects.length > 0 ? (
            <div className="projects-page__hint" data-testid="projects-select-hint">{t('projects.selectHint')}</div>
          ) : null
        )}
        <div className="projects-page__tabs" role="tablist" aria-label={t('projects.pageTitle')}>
          {MODES.map((entry) => (
            <button
              key={entry.id}
              type="button"
              role="tab"
              className={`projects-page__tab ${mode === entry.id ? 'active' : ''}`}
              aria-selected={mode === entry.id}
              data-testid={entry.testId}
              onClick={() => onModeChange(entry.id)}
            >
              {t(entry.labelKey)}
            </button>
          ))}
        </div>
        <div className="projects-page__content">
          {(mode === 'chat' || mode === 'kanban') && (
            <div className="projects-page__chat">
              <div
                className="projects-page__chat-workspace"
                style={previewOpen ? { minWidth: 360 } : undefined}
              >{chatContent}</div>
              <SplitHandle
                label={locale === 'zh' ? '拖动调整右侧面板宽度' : 'Drag to resize the side panel'}
                testId="projects-split-chat-right"
                onDrag={handleChatRightDrag}
                onKeyDelta={(delta) => {
                  setChatRightWidth((current) => Math.min(560, Math.max(240, current - delta)));
                }}
              />
              <div className={`projects-page__chat-right${chatRightWidth >= 280 ? ' projects-page__chat-right--pinned' : ''}`} style={{ width: chatRightWidth }}>{chatRightPanel}</div>
              {previewOpen && (
                <>
                  <SplitHandle
                    label={locale === 'zh' ? '拖动调整预览栏宽度' : 'Drag to resize the preview pane'}
                    testId="projects-split-preview"
                    onDrag={handlePreviewDrag}
                    onKeyDelta={(delta) => {
                      setPreviewWidth((current) => Math.min(800, Math.max(360, current - delta)));
                    }}
                  />
                  <div
                    className="projects-page__preview"
                    style={{ width: previewWidth, maxWidth: 'calc(100% - 680px)' }}
                  >{previewPanel}</div>
                </>
              )}
            </div>
          )}
          {mode === 'materials' && (
            <div className="projects-page__materials">
            <ProjectMaterialsPanel projectId={activeProjectId} />
            <LibraryPage
              key={activeProjectId ?? 'no-project'}
              projectId={activeProjectId}
            />
            </div>
          )}
        </div>
      </div>
      {deleteTarget && (
        <ConfirmDialog
          title={locale === 'zh' ? '删除项目' : 'Delete project'}
          message={locale === 'zh'
            ? `确定删除项目「${deleteTarget.title}」吗？`
            : `Delete project “${deleteTarget.title}”?`}
          impacts={[
            locale === 'zh' ? '项目将从项目列表中移除，聊天、任务与资料随之隐藏。' : 'The project is removed from the list; its chat, tasks, and materials are hidden.',
            locale === 'zh' ? '删除进入回收站，可在项目侧栏「回收站」中恢复。' : 'The delete goes to the recycle bin and can be restored from the sidebar Recycle Bin.',
          ]}
          confirmLabel={t('projects.confirmDelete')}
          busy={deleteBusy}
          onConfirm={() => void confirmDelete()}
          onCancel={() => { if (!deleteBusy) setDeleteTarget(null); }}
        />
      )}
    </div>
  );
}
