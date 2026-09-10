import {
  Activity,
  ArchiveRestore,
  BookOpen,
  Download,
  CheckIcon,
  FileOutput,
  FolderKanban,
  GitBranch,
  Image,
  Lightbulb,
  LoaderCircle,
  Plus,
  Quote,
  RefreshCw,
  Search,
  Tags,
  Trash2,
  Upload,
  X,
} from 'lucide-react';
import {
  useEffect,
  useCallback,
  useId,
  useMemo,
  useRef,
  useState,
  type FormEvent,
  type KeyboardEvent,
} from 'react';
import {
  RESEARCH_MEDIA_TYPES,
  ResearchMediaAttachRequestSchema,
  type ResearchMediaAttachRequest,
} from '../../engine/runtime/ResearchMediaRuntimeContract';
import type { FileCapabilityDescriptor } from '../../engine/runtime/FileCapabilityContract';
import { useTranslation, type LocaleKey } from '../i18n';
import {
  researchWorkspaceStore,
  useResearchWorkspaceStore,
  type ResearchWorkspaceError,
  type ResearchWorkspaceSection,
} from './researchWorkspaceStore';
import './ResearchWorkspace.css';

const SIDEBAR_COPY = {
  zh: {
    importImageInputInvalid: '图片说明或排序位置无效。请检查后重试。',
    workspace: '研究项目',
    persistentContext: '持久项目工作台',
    newProject: '新建项目',
    importProject: '导入项目',
    searchProjects: '搜索项目',
    refresh: '刷新研究工作台',
    exportProject: '导出项目',
    exportProjectSuccess: '已导出：{path}',
    exportProjectFailed: '导出项目失败：{error}',
    exportProjectRunning: '正在导出…',
    loading: '正在同步项目…',
    empty: '尚无研究项目。创建一个项目后，资料、证据、论断与成果会持续保留在同一工作台中。',
    createTitle: '创建研究项目',
    projectName: '项目名称',
    projectNamePlaceholder: '例如：生成式 AI 对科研写作的影响',
    originalIntent: '原始研究意图（可选）',
    originalIntentPlaceholder: '用一句话记录为什么要做这项研究',
    cancel: '取消',
    create: '创建项目',
    required: '请输入项目名称。',
    projectOverview: '项目设计',
    sources: '资料来源',
    importImageSource: '导入图片来源',
    importImageSourceTitle: '导入图片来源',
    importImageCaption: '图片说明',
    importImageCaptionPlaceholder: '简短描述这张图片在研究中的作用',
    importImageOrdinal: '排序位置',
    importImageOrdinalHelp: '0–15 之间的整数，决定同项目图片的显示顺序',
    importImageOrdinalInvalid: '排序位置必须是 0–15 之间的整数。',
    importImageOrdinalExhausted: '单个项目最多支持 16 张图片。',
    importImageUnsupportedMime: '仅支持 PNG、JPEG、GIF 格式的图片。',
    importImageInvalidCapability: '请选择一个可读的文件。',
    importImageCaptionRequired: '请输入图片说明。',
    importImageConflict: '该图片标识已存在，请重新选择文件。',
    importImageUnavailable: '图片导入服务暂时不可用，请稍后重试。',
    importImageFailed: '图片导入失败，请重试。',
    importImageReferenced: '该图片已被引用，无法清除。',
    importImageCancel: '取消导入',
    importImageConfirm: '确认导入',
    evidence: '证据摘录',
    noteCodes: '笔记与编码',
    claims: '论断网络',
    artifacts: '研究成果',
    runs: '执行记录',
    goals: '任务',
    recycleBin: '回收站',
    activeProject: '当前项目',
    noActiveProject: '未选择项目',
    unavailable: '研究数据接口尚未接入，请稍后刷新。',
    projectListUnavailable: '暂时无法读取项目列表。',
    snapshotUnavailable: '暂时无法读取当前项目。',
    mutationUnavailable: '变更未保存，请重试。',
    closeError: '关闭提示',
  },
  en: {
    importImageInputInvalid: 'The image import details are invalid. Check the caption and ordinal.',
    workspace: 'Research projects',
    persistentContext: 'Persistent project workspace',
    newProject: 'New project',
    importProject: 'Import project',
    searchProjects: 'Search projects',
    refresh: 'Refresh research workspace',
    exportProject: 'Export project',
    exportProjectSuccess: 'Exported: {path}',
    exportProjectFailed: 'Project export failed: {error}',
    exportProjectRunning: 'Exporting…',
    loading: 'Syncing projects…',
    empty: 'No research projects yet. Create one to keep sources, evidence, claims, and outputs in one persistent workspace.',
    createTitle: 'Create research project',
    projectName: 'Project name',
    projectNamePlaceholder: 'Example: How generative AI changes research writing',
    originalIntent: 'Original research intent (optional)',
    originalIntentPlaceholder: 'Capture in one sentence why this research matters',
    cancel: 'Cancel',
    create: 'Create project',
    required: 'Enter a project name.',
    projectOverview: 'Project design',
    sources: 'Sources',
    importImageSource: 'Import image source',
    importImageSourceTitle: 'Import image source',
    importImageCaption: 'Caption',
    importImageCaptionPlaceholder: 'Briefly describe the role of this image in the research',
    importImageOrdinal: 'Ordinal',
    importImageOrdinalHelp: 'An integer between 0 and 15 that controls display order',
    importImageOrdinalInvalid: 'Ordinal must be an integer between 0 and 15.',
    importImageOrdinalExhausted: 'A project can contain at most 16 images.',
    importImageUnsupportedMime: 'Only PNG, JPEG, and GIF images are supported.',
    importImageInvalidCapability: 'Select a readable file.',
    importImageCaptionRequired: 'Enter a caption for the image.',
    importImageConflict: 'A source with this identifier already exists. Select a different file.',
    importImageUnavailable: 'Image import is temporarily unavailable. Try again later.',
    importImageFailed: 'Image import failed. Try again.',
    importImageReferenced: 'This image is referenced and cannot be removed.',
    importImageCancel: 'Cancel import',
    importImageConfirm: 'Confirm import',
    evidence: 'Evidence',
    noteCodes: 'Notes & codes',
    claims: 'Claim network',
    artifacts: 'Research outputs',
    runs: 'Run history',
    goals: 'Tasks',
    recycleBin: 'Recycle bin',
    activeProject: 'Active project',
    noActiveProject: 'No project selected',
    unavailable: 'The research data bridge is not connected yet. Refresh after it becomes available.',
    projectListUnavailable: 'Projects are temporarily unavailable.',
    snapshotUnavailable: 'The active project is temporarily unavailable.',
    mutationUnavailable: 'The change was not saved. Try again.',
    closeError: 'Dismiss message',
  },
} as const;

type SidebarCopy = (typeof SIDEBAR_COPY)[LocaleKey];

interface NavigationItem {
  section: ResearchWorkspaceSection;
  label: keyof Pick<
    SidebarCopy,
    'projectOverview' | 'sources' | 'evidence' | 'noteCodes' | 'claims' | 'artifacts' | 'goals'
  >;
  icon: typeof FolderKanban;
  count: number | null;
}

export interface ProjectWorkspaceSidebarProps {
  className?: string;
  onProjectCreated?: (projectId: string) => void;
}

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

function makeMediaSourceId(): string {
  try {
    if (typeof crypto !== 'undefined' && typeof crypto.randomUUID === 'function') {
      return `source-${crypto.randomUUID()}`;
    }
  } catch {
    // Bounded fallback; still distinct from project ids.
  }
  return `source-${Date.now()}-${Math.random().toString(36).slice(2, 10)}`;
}

function errorMessage(error: ResearchWorkspaceError, copy: SidebarCopy): string {
  if (error.code === 'research_project_list_unavailable') return copy.projectListUnavailable;
  if (error.code === 'research_snapshot_unavailable') return copy.snapshotUnavailable;
  if (error.code === 'research_mutation_unavailable') return copy.mutationUnavailable;
  return copy.unavailable;
}

export default function ProjectWorkspaceSidebar({
  className = '',
  onProjectCreated,
}: ProjectWorkspaceSidebarProps) {
  const { locale } = useTranslation();
  const copy = SIDEBAR_COPY[locale];
  const projects = useResearchWorkspaceStore((state) => state.projects);
  const activeProjectId = useResearchWorkspaceStore((state) => state.activeProjectId);
  const snapshot = useResearchWorkspaceStore((state) => state.snapshot);
  const activeSection = useResearchWorkspaceStore((state) => state.activeSection);
  const query = useResearchWorkspaceStore((state) => state.projectQuery);
  const loading = useResearchWorkspaceStore((state) => state.loading);
  const error = useResearchWorkspaceStore((state) => state.error);
  const createOpen = useResearchWorkspaceStore((state) => state.isCreateProjectOpen);
  const setProjectQuery = useResearchWorkspaceStore((state) => state.setProjectQuery);
  const setCreateOpen = useResearchWorkspaceStore((state) => state.setCreateProjectOpen);
  const setImportCreateOpen = useResearchWorkspaceStore((state) => state.setImportCreateOpen);
  const setActiveProject = useResearchWorkspaceStore((state) => state.setActiveProject);
  const setActiveSection = useResearchWorkspaceStore((state) => state.setActiveSection);
  const refreshWorkspace = useResearchWorkspaceStore((state) => state.refreshWorkspace);
  const createProject = useResearchWorkspaceStore((state) => state.createProject);
  const clearError = useResearchWorkspaceStore((state) => state.clearError);
  const applyAttachMedia = useResearchWorkspaceStore((state) => state.applyAttachMedia);
  const selectItem = useResearchWorkspaceStore((state) => state.selectItem);
  const [focusedProjectIndex, setFocusedProjectIndex] = useState(0);
  const [title, setTitle] = useState('');
  const [intent, setIntent] = useState('');
  const [formError, setFormError] = useState('');
  // 新建项目时选择场景（2026-08-29 刘总要求）：可选绑定一个已启用场景，
  // 创建后自动作为该项目的对话场景。
  const [createScenarioOptions, setCreateScenarioOptions] = useState<Array<{ id: string; name: string }>>([]);
  const [createScenarioId, setCreateScenarioId] = useState('');
  const [imageImportOpen, setImageImportOpen] = useState(false);
  const [imageImportCapability, setImageImportCapability] = useState<FileCapabilityDescriptor | null>(null);
  const [imageImportCaption, setImageImportCaption] = useState('');
  const [exporting, setExporting] = useState(false);
  const [exportNotice, setExportNotice] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  // Export the active project as a single .mts archive that can be
  // imported on another device (research entities + attachments + linked
  // library papers and their PDFs).
  const handleExportProject = useCallback(async () => {
    const projectId = researchWorkspaceStore.getState().activeProjectId;
    if (!projectId || exporting) return;
    setExporting(true);
    setExportNotice(null);
    try {
      const result = await window.metis?.exportProject?.({ projectId });
      if (result?.ok && result.path) {
        setExportNotice({ kind: 'success', message: copy.exportProjectSuccess.replace('{path}', result.path) });
      } else {
        setExportNotice({ kind: 'error', message: copy.exportProjectFailed.replace('{error}', result?.error ?? 'unknown') });
      }
    } catch (err) {
      setExportNotice({
        kind: 'error',
        message: copy.exportProjectFailed.replace('{error}', err instanceof Error ? err.message : String(err)),
      });
    } finally {
      setExporting(false);
    }
  }, [exporting, copy]);
  const [imageImportOrdinal, setImageImportOrdinal] = useState(0);
  const [imageImportOrdinalRaw, setImageImportOrdinalRaw] = useState('0');
  const [imageImportError, setImageImportError] = useState('');
  const [imageImportBusy, setImageImportBusy] = useState(false);
  const createPanelId = useId();
  const createTitleId = useId();
  const createErrorId = useId();
  const projectListLabelId = useId();
  const imageImportTitleId = useId();
  const imageImportErrorId = useId();
  const imageImportOrdinalHelpId = useId();
  const imageImportCaptionRef = useRef<HTMLInputElement>(null);
  const projectButtonRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const createTitleRef = useRef<HTMLInputElement>(null);
  const initialLoadStarted = useRef(false);

  useEffect(() => {
    if (initialLoadStarted.current) return;
    initialLoadStarted.current = true;
    void refreshWorkspace();
  }, [refreshWorkspace]);

  useEffect(() => {
    if (createOpen) requestAnimationFrame(() => createTitleRef.current?.focus());
  }, [createOpen]);

  useEffect(() => {
    if (imageImportOpen) requestAnimationFrame(() => imageImportCaptionRef.current?.focus());
  }, [imageImportOpen]);

  const visibleProjects = useMemo(() => {
    const normalized = query.trim().toLocaleLowerCase(locale);
    if (!normalized) return projects;
    return projects.filter((project) => (
      project.title.toLocaleLowerCase(locale).includes(normalized)
      || project.researchQuestion.toLocaleLowerCase(locale).includes(normalized)
    ));
  }, [locale, projects, query]);

  useEffect(() => {
    const activeIndex = visibleProjects.findIndex((project) => project.id === activeProjectId);
    // Keep the roving keyboard focus index aligned with the active project
    // whenever the filtered project list changes. This avoids focus landing on
    // a stale or out-of-range option after search/filter updates.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setFocusedProjectIndex(activeIndex >= 0 ? activeIndex : 0);
  }, [activeProjectId, visibleProjects]);

  const navigationItems = useMemo<NavigationItem[]>(() => [
    {
      section: 'project',
      label: 'projectOverview',
      icon: Lightbulb,
      count: snapshot ? 1 : null,
    },
    {
      section: 'sources',
      label: 'sources',
      icon: BookOpen,
      count: snapshot?.sources.filter((item) => item.deletedAt === null).length ?? null,
    },
    {
      section: 'evidence',
      label: 'evidence',
      icon: Quote,
      count: snapshot?.evidence.filter((item) => item.deletedAt === null).length ?? null,
    },
    {
      section: 'note_codes',
      label: 'noteCodes',
      icon: Tags,
      count: snapshot?.noteCodes.filter((item) => item.deletedAt === null).length ?? null,
    },
    {
      section: 'claims',
      label: 'claims',
      icon: GitBranch,
      count: snapshot?.claims.filter((item) => item.deletedAt === null).length ?? null,
    },
    {
      section: 'artifacts',
      label: 'artifacts',
      icon: FileOutput,
      count: snapshot?.artifacts.filter((item) => item.deletedAt === null).length ?? null,
    },
    {
      section: 'goals',
      label: 'goals',
      icon: CheckIcon,
      count: null,
    },
  ], [snapshot]);

  const recycleCount = snapshot
    ? [
        snapshot.project,
        ...snapshot.sources,
        ...snapshot.evidence,
        ...snapshot.noteCodes,
        ...snapshot.claims,
        ...snapshot.artifacts,
      ].filter((item) => item.deletedAt !== null).length
    : 0;

  const focusProject = (index: number) => {
    if (visibleProjects.length === 0) return;
    const bounded = Math.max(0, Math.min(visibleProjects.length - 1, index));
    setFocusedProjectIndex(bounded);
    requestAnimationFrame(() => projectButtonRefs.current[bounded]?.focus());
  };

  const handleProjectKeyDown = (
    event: KeyboardEvent<HTMLButtonElement>,
    index: number,
  ) => {
    if (event.key === 'ArrowDown') {
      event.preventDefault();
      focusProject(index + 1);
    } else if (event.key === 'ArrowUp') {
      event.preventDefault();
      focusProject(index - 1);
    } else if (event.key === 'Home') {
      event.preventDefault();
      focusProject(0);
    } else if (event.key === 'End') {
      event.preventDefault();
      focusProject(visibleProjects.length - 1);
    }
  };

  const resetCreateForm = () => {
    setTitle('');
    setIntent('');
    setFormError('');
  };

  // 打开新建表单时加载可绑定场景清单（2026-08-29 刘总要求：新建项目可选择场景）。
  const openCreateForm = () => {
    setCreateOpen(true);
    try {
      void window.metis?.listPersonalization?.({ contractVersion: 1, kind: 'scenario', includeDisabled: false })
        ?.then((response) => {
          setCreateScenarioOptions(response.definitions
            .filter((definition) => definition.kind === 'scenario'
              && definition.enabled
              && definition.provenance.origin !== 'builtin')
            .map((definition) => ({ id: definition.id, name: definition.name })));
        })
        .catch(() => setCreateScenarioOptions([]));
    } catch {
      setCreateScenarioOptions([]);
    }
  };

  const closeCreateForm = () => {
    resetCreateForm();
    setCreateScenarioId('');
    setCreateOpen(false);
  };

  function resetImageImportForm() {
    setImageImportCapability(null);
    setImageImportCaption('');
    setImageImportOrdinal(0);
    setImageImportOrdinalRaw('0');
    setImageImportError('');
  }

  function closeImageImportForm() {
    resetImageImportForm();
    setImageImportOpen(false);
    setImageImportBusy(false);
  }

  function nextImageOrdinal(): number | null {
    if (!snapshot) return 0;
    const imageSources = snapshot.sources.filter((source) => source.kind === 'image');
    const next = imageSources.length;
    if (next > 15) return null;
    return next;
  }

  function validateImageOrdinal(raw: string, value: number): string | null {
    if (!/^-?\d+$/.test(raw) || !Number.isInteger(value) || value < 0 || value > 15) {
      return copy.importImageOrdinalInvalid;
    }
    return null;
  }

  async function startImageImport() {
    setImageImportError('');
    const metis = (window as unknown as { metis?: Record<string, unknown> }).metis;
    if (!metis || typeof metis.selectFileCapability !== 'function') {
      setImageImportError(copy.importImageFailed);
      return;
    }
    setImageImportBusy(true);
    let selection: unknown;
    try {
      selection = await metis.selectFileCapability('research-source');
    } catch {
      selection = { success: false };
    }
    setImageImportBusy(false);
    if (
      !selection
      || typeof selection !== 'object'
      || selection === null
      || !('success' in selection)
      || selection.success !== true
      || !('capability' in selection)
    ) {
      // Cancelled or unavailable: fail-closed, no error banner.
      return;
    }
    const capability = (selection as { capability: FileCapabilityDescriptor }).capability;
    if (
      capability.kind !== 'file'
      || !Array.isArray(capability.operations)
      || !capability.operations.includes('read')
    ) {
      // The selected capability is not a readable file: discard it and require re-selection.
      setImageImportError(copy.importImageInvalidCapability);
      return;
    }
    if (!RESEARCH_MEDIA_TYPES.includes(capability.mime as typeof RESEARCH_MEDIA_TYPES[number])) {
      setImageImportError(copy.importImageUnsupportedMime);
      return;
    }
    const nextOrdinal = nextImageOrdinal();
    if (nextOrdinal === null) {
      setImageImportError(copy.importImageOrdinalExhausted);
      return;
    }
    setImageImportCapability(capability);
    setImageImportOrdinal(nextOrdinal);
    setImageImportOrdinalRaw(String(nextOrdinal));
    setImageImportOpen(true);
  }

  async function submitImageImport(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const normalizedCaption = imageImportCaption.trim();
    if (!normalizedCaption) {
      setImageImportError(copy.importImageCaptionRequired);
      imageImportCaptionRef.current?.focus();
      return;
    }
    const projectId = activeProjectId;
    const capability = imageImportCapability;
    if (!projectId || !capability) {
      setImageImportError(copy.importImageFailed);
      return;
    }
    const ordinalError = validateImageOrdinal(imageImportOrdinalRaw, imageImportOrdinal);
    if (ordinalError) {
      setImageImportError(ordinalError);
      return;
    }
    const sourceId = makeMediaSourceId();
    const request: ResearchMediaAttachRequest = {
      projectId,
      sourceId,
      capabilityId: capability.capabilityId,
      caption: normalizedCaption,
      ordinal: imageImportOrdinal,
    };
    const parsedRequest = ResearchMediaAttachRequestSchema.safeParse(request);
    if (!parsedRequest.success) {
      setImageImportError(copy.importImageInputInvalid);
      imageImportCaptionRef.current?.focus();
      return;
    }
    // Consume the capability immediately: any failure requires a fresh select.
    setImageImportCapability(null);
    setImageImportBusy(true);
    setImageImportError('');
    const result = await applyAttachMedia(parsedRequest.data);
    setImageImportBusy(false);
    if (!result.success) {
      if (result.code === 'research_media_conflict') {
        setImageImportError(copy.importImageConflict);
      } else if (result.code === 'research_media_unavailable') {
        setImageImportError(copy.importImageUnavailable);
      } else {
        setImageImportError(copy.importImageFailed);
      }
      return;
    }
    // Guard against A→B project race: only switch selection if we are still on the same project
    // and the backend snapshot actually contains the new source.
    const currentState = researchWorkspaceStore.getState();
    if (
      currentState.activeProjectId === projectId
      && currentState.snapshot?.sources.some((source) => source.id === sourceId)
    ) {
      setActiveSection('sources');
      selectItem({ kind: 'source', id: sourceId });
    }
    closeImageImportForm();
  }

  const submitCreate = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    const normalizedTitle = title.trim();
    if (!normalizedTitle) {
      setFormError(copy.required);
      createTitleRef.current?.focus();
      return;
    }
    const projectId = makeProjectId();
    const result = await createProject({
      projectId,
      title: normalizedTitle,
      originalIntent: intent.trim(),
    });
    if (result.success) {
      // 绑定场景（2026-08-29 刘总要求）：写入全局偏好与项目级偏好，
      // 项目的对话会优先使用项目级场景。
      if (createScenarioId) {
        try {
          window.localStorage.setItem('metis:active-scenario-id', createScenarioId);
          window.localStorage.setItem(`metis:project-scenario:${projectId}`, createScenarioId);
        } catch { /* preference persistence is best-effort */ }
      }
      resetCreateForm();
      setCreateScenarioId('');
      onProjectCreated?.(result.resourceId);
    }
  };

  return (
    <aside className={`research-workspace-sidebar ${className}`.trim()} aria-label={copy.workspace}>
      <header className="research-workspace-sidebar__header">
        <div className="research-workspace-sidebar__heading">
          <span className="research-workspace-sidebar__mark" aria-hidden="true">
            <FolderKanban size={17} />
          </span>
          <span>
            <strong>{copy.workspace}</strong>
            <small>{copy.persistentContext}</small>
          </span>
        </div>
        <button
          type="button"
          className="research-icon-button"
          onClick={() => void refreshWorkspace()}
          disabled={loading.projects || loading.snapshot}
          aria-label={copy.refresh}
        >
          <RefreshCw
            size={16}
            aria-hidden="true"
            className={loading.projects || loading.snapshot ? 'is-spinning' : undefined}
          />
        </button>
      </header>

      <div className="research-workspace-sidebar__actions">
        <button
          type="button"
          className="research-workspace-sidebar__create"
          onClick={() => openCreateForm()}
          aria-expanded={createOpen}
          aria-controls={createPanelId}
        >
          <Plus size={16} aria-hidden="true" />
          {copy.newProject}
        </button>
        <button
          type="button"
          className="research-workspace-sidebar__import"
          onClick={() => setImportCreateOpen(true)}
          aria-label={copy.importProject}
          title={copy.importProject}
        >
          <Upload size={16} aria-hidden="true" />
        </button>
      </div>

      {createOpen && (
        <form
          id={createPanelId}
          className="research-workspace-create"
          onSubmit={(event) => void submitCreate(event)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeCreateForm();
            }
          }}
          aria-labelledby={createTitleId}
        >
          <div className="research-workspace-create__heading">
            <strong id={createTitleId}>{copy.createTitle}</strong>
            <button
              type="button"
              className="research-icon-button research-icon-button--quiet"
              onClick={closeCreateForm}
              aria-label={copy.cancel}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          <label>
            <span>{copy.projectName}</span>
            <input
              ref={createTitleRef}
              value={title}
              onChange={(event) => {
                setTitle(event.target.value);
                if (formError) setFormError('');
              }}
              maxLength={512}
              placeholder={copy.projectNamePlaceholder}
              aria-invalid={formError ? true : undefined}
              aria-describedby={formError ? createErrorId : undefined}
            />
          </label>
          <label>
            <span>{copy.originalIntent}</span>
            <textarea
              value={intent}
              onChange={(event) => setIntent(event.target.value)}
              maxLength={4_000}
              rows={3}
              placeholder={copy.originalIntentPlaceholder}
            />
          </label>
          <label>
            <span>{locale === 'zh' ? '绑定场景（可选）' : 'Scenario (optional)'}</span>
            <select
              value={createScenarioId}
              onChange={(event) => setCreateScenarioId(event.target.value)}
            >
              <option value="">{locale === 'zh' ? '不绑定场景' : 'No scenario'}</option>
              {createScenarioOptions.map((scenario) => (
                <option key={scenario.id} value={scenario.id}>{scenario.name}</option>
              ))}
            </select>
          </label>
          {formError && (
            <p id={createErrorId} className="research-workspace-form-error" role="alert">
              {formError}
            </p>
          )}
          <div className="research-workspace-create__actions">
            <button type="button" className="research-button research-button--quiet" onClick={closeCreateForm}>
              {copy.cancel}
            </button>
            <button type="submit" className="research-button research-button--primary" disabled={loading.mutation}>
              {loading.mutation && <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />}
              {copy.create}
            </button>
          </div>
        </form>
      )}

      {imageImportOpen && (
        <form
          className="research-workspace-create research-workspace-image-import"
          noValidate
          onSubmit={(event) => void submitImageImport(event)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') {
              event.preventDefault();
              closeImageImportForm();
            }
          }}
          aria-labelledby={imageImportTitleId}
        >
          <div className="research-workspace-create__heading">
            <strong id={imageImportTitleId}>{copy.importImageSourceTitle}</strong>
            <button
              type="button"
              className="research-icon-button research-icon-button--quiet"
              onClick={closeImageImportForm}
              aria-label={copy.cancel}
            >
              <X size={15} aria-hidden="true" />
            </button>
          </div>
          {imageImportCapability && (
            <div className="research-workspace-image-import__file">
              <Image size={14} aria-hidden="true" />
              <span>{imageImportCapability.displayName}</span>
            </div>
          )}
          <label>
            <span>{copy.importImageCaption}</span>
            <input
              ref={imageImportCaptionRef}
              value={imageImportCaption}
              onChange={(event) => {
                setImageImportCaption(event.target.value);
                if (imageImportError) setImageImportError('');
              }}
              maxLength={512}
              placeholder={copy.importImageCaptionPlaceholder}
              aria-invalid={imageImportError ? true : undefined}
              aria-describedby={imageImportError ? imageImportErrorId : undefined}
            />
          </label>
          <label>
            <span>{copy.importImageOrdinal}</span>
            <input
              type="number"
              min={0}
              max={15}
              step={1}
              value={imageImportOrdinalRaw}
              onChange={(event) => {
                setImageImportOrdinalRaw(event.target.value);
                setImageImportOrdinal(Number(event.target.value));
                if (imageImportError) setImageImportError('');
              }}
              aria-describedby={imageImportOrdinalHelpId}
            />
            <small id={imageImportOrdinalHelpId}>{copy.importImageOrdinalHelp}</small>
          </label>
          {imageImportError && (
            <p id={imageImportErrorId} className="research-workspace-form-error" role="alert">
              {imageImportError}
            </p>
          )}
          <div className="research-workspace-create__actions">
            <button
              type="button"
              className="research-button research-button--quiet"
              onClick={closeImageImportForm}
              disabled={imageImportBusy}
            >
              {copy.importImageCancel}
            </button>
            <button type="submit" className="research-button research-button--primary" disabled={imageImportBusy}>
              {imageImportBusy && <LoaderCircle size={14} className="is-spinning" aria-hidden="true" />}
              {copy.importImageConfirm}
            </button>
          </div>
        </form>
      )}

      <div className="research-workspace-search">
        <Search size={15} aria-hidden="true" />
        <input
          type="search"
          value={query}
          onChange={(event) => setProjectQuery(event.target.value)}
          placeholder={copy.searchProjects}
          aria-label={copy.searchProjects}
        />
      </div>

      {error && (
        <div className="research-workspace-alert" role="status" aria-live="polite">
          <span>{errorMessage(error, copy)}</span>
          <button type="button" onClick={clearError} aria-label={copy.closeError}>
            <X size={14} aria-hidden="true" />
          </button>
        </div>
      )}

      <section className="research-workspace-projects" aria-labelledby={projectListLabelId}>
        <div className="research-workspace-section-label" id={projectListLabelId}>
          {copy.activeProject}
        </div>
        {loading.projects && projects.length === 0 ? (
          <div className="research-workspace-loading" role="status">
            <LoaderCircle size={15} className="is-spinning" aria-hidden="true" />
            {copy.loading}
          </div>
        ) : visibleProjects.length === 0 ? (
          <p className="research-workspace-empty">{copy.empty}</p>
        ) : (
          <div className="research-project-list" role="listbox" aria-label={copy.workspace}>
            {visibleProjects.map((project, index) => {
              const active = project.id === activeProjectId;
              return (
                <button
                  key={project.id}
                  ref={(element) => { projectButtonRefs.current[index] = element; }}
                  type="button"
                  role="option"
                  aria-selected={active}
                  tabIndex={focusedProjectIndex === index ? 0 : -1}
                  className={`research-project-option ${active ? 'is-active' : ''}`}
                  onFocus={() => setFocusedProjectIndex(index)}
                  onClick={() => void setActiveProject(project.id)}
                  onKeyDown={(event) => handleProjectKeyDown(event, index)}
                >
                  <span className="research-project-option__glyph" aria-hidden="true">
                    {project.title.slice(0, 1).toLocaleUpperCase(locale)}
                  </span>
                  <span className="research-project-option__copy">
                    <strong>{project.title}</strong>
                    <small>{project.researchQuestion || project.originalIntent || copy.persistentContext}</small>
                  </span>
                  <span className={`research-lifecycle-dot is-${project.lifecycle}`} aria-hidden="true" />
                </button>
              );
            })}
          </div>
        )}
      </section>

      <nav className="research-workspace-navigation" aria-label={copy.activeProject}>
        <div className="research-workspace-section-label">
          {snapshot?.project.title ?? copy.noActiveProject}
        </div>
        {navigationItems.map((item) => {
          const Icon = item.icon;
          const active = activeSection === item.section;
          const isSources = item.section === 'sources';
          const button = (
            <button
              key={item.section}
              type="button"
              className={`research-navigation-item ${active ? 'is-active' : ''}`}
              onClick={() => setActiveSection(item.section)}
              aria-current={active ? 'page' : undefined}
              disabled={!snapshot}
            >
              <Icon size={16} aria-hidden="true" />
              <span>{copy[item.label]}</span>
              {item.count !== null && <span className="research-navigation-count">{item.count}</span>}
            </button>
          );
          if (!isSources) return button;
          return (
            <div key={`${item.section}-group`} className="research-navigation-item-group">
              {button}
              <button
                type="button"
                className="research-navigation-item research-navigation-item--import-image"
                onClick={() => void startImageImport()}
                disabled={!snapshot || imageImportBusy}
                aria-label={copy.importImageSource}
                title={copy.importImageSource}
              >
                <Image size={16} aria-hidden="true" />
                <span>{copy.importImageSource}</span>
                {imageImportBusy && <LoaderCircle size={13} className="is-spinning" aria-hidden="true" />}
              </button>
              {imageImportError && !imageImportOpen && (
                <p className="research-workspace-form-error research-workspace-image-import__error" role="alert">
                  {imageImportError}
                </p>
              )}
            </div>
          );
        })}
        <div className="research-navigation-divider" />
        <button
          type="button"
          className={`research-navigation-item ${activeSection === 'runs' ? 'is-active' : ''}`}
          onClick={() => setActiveSection('runs')}
          aria-current={activeSection === 'runs' ? 'page' : undefined}
          disabled={!snapshot}
        >
          <Activity size={16} aria-hidden="true" />
          <span>{copy.runs}</span>
          {snapshot && <span className="research-navigation-count">{snapshot.runs.length}</span>}
        </button>
        <button
          type="button"
          className={`research-navigation-item research-navigation-item--recycle ${activeSection === 'recycle_bin' ? 'is-active' : ''}`}
          onClick={() => setActiveSection('recycle_bin')}
          aria-current={activeSection === 'recycle_bin' ? 'page' : undefined}
          disabled={!snapshot}
        >
          {recycleCount > 0 ? <ArchiveRestore size={16} aria-hidden="true" /> : <Trash2 size={16} aria-hidden="true" />}
          <span>{copy.recycleBin}</span>
          <span className="research-navigation-count">{recycleCount}</span>
        </button>
        <div className="research-navigation-divider" />
        <button
          type="button"
          className="research-navigation-item"
          onClick={() => void handleExportProject()}
          disabled={!snapshot || exporting}
          aria-label={copy.exportProject}
          title={copy.exportProject}
          data-testid="sidebar-export-project"
        >
          <Download size={16} aria-hidden="true" />
          <span>{exporting ? copy.exportProjectRunning : copy.exportProject}</span>
          {exporting && <LoaderCircle size={13} className="is-spinning" aria-hidden="true" />}
        </button>
        {exportNotice && (
          <p
            className="research-workspace-form-error"
            role="status"
            style={{ color: exportNotice.kind === 'error' ? 'var(--status-failed)' : 'var(--status-completed)' }}
          >
            {exportNotice.message}
          </p>
        )}
      </nav>

      <footer className="research-workspace-sidebar__footer">
        <span className="research-workspace-context-dot" aria-hidden="true" />
        <span>{snapshot?.project.title ?? copy.persistentContext}</span>
      </footer>
    </aside>
  );
}

export { SIDEBAR_COPY };
