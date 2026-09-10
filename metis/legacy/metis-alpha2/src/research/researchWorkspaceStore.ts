import { useStore } from 'zustand';
import { createStore, type StoreApi } from 'zustand/vanilla';
import {
  createResearchMediaAttachFailure,
  createResearchMediaPurgeFailure,
  decodeResearchMediaAttachResult,
  decodeResearchMediaPurgeResult,
  type ResearchMediaAttachRequest,
  type ResearchMediaAttachResult,
  type ResearchMediaPurgeRequest,
  type ResearchMediaPurgeResult,
} from '../../engine/runtime/ResearchMediaRuntimeContract';
import {
  createResearchMutationRecovery,
  createResearchSnapshotRecovery,
  decodeLegacyResearchEntityList,
  decodeResearchCheckpointRequest,
  decodeResearchCrudRequest,
  decodeResearchDecisionRequest,
  decodeResearchEntityListResult,
  decodeResearchLinkRequest,
  decodeResearchMutationResult,
  decodeResearchRestoreRequest,
  decodeResearchReviewRequest,
  decodeResearchSnapshotRequest,
  decodeResearchSnapshotPayload,
  decodeResearchVersionRequest,
  type ProjectSnapshotRuntime,
  type ResearchCheckpointRequest,
  type ResearchCrudRequest,
  type ResearchDecisionRequest,
  type ResearchEntityListResult,
  type ResearchLinkRequest,
  type ResearchMutationResult,
  type ResearchProjectDto,
  type ResearchRestoreRequest,
  type ResearchReviewRequest,
  type ResearchSnapshotRequest,
  type ResearchSnapshotResult,
  type ResearchVersionRequest,
} from '../../engine/runtime/ResearchRuntimeContract';

export type ResearchWorkspaceSection =
  | 'project'
  | 'sources'
  | 'evidence'
  | 'note_codes'
  | 'claims'
  | 'artifacts'
  | 'runs'
  | 'goals'
  | 'recycle_bin';

export type ResearchWorkspaceSelection =
  | { kind: 'project'; id: string }
  | { kind: 'source'; id: string }
  | { kind: 'evidence'; id: string }
  | { kind: 'note_code'; id: string }
  | { kind: 'claim'; id: string }
  | { kind: 'artifact'; id: string }
  | { kind: 'run'; id: string }
  | null;

export type ResearchCrudMutationRequest = Extract<
  ResearchCrudRequest,
  { operation: 'create' | 'update' | 'delete' }
>;

export type ResearchLinkMutationRequest = Extract<
  ResearchLinkRequest,
  { operation: 'link' | 'unlink' }
>;

export type ResearchVersionMutationRequest = Extract<
  ResearchVersionRequest,
  { operation: 'save_version' | 'restore_version' }
>;

export type ResearchCheckpointMutationRequest = Extract<
  ResearchCheckpointRequest,
  { operation: 'record_checkpoint' }
>;

export type ResearchDecisionMutationRequest = Extract<
  ResearchDecisionRequest,
  { operation: 'record_decision' | 'undo_decision' }
>;

export interface ResearchProjectCreateInput {
  projectId: string;
  title: string;
  originalIntent?: string;
  researchQuestion?: string;
  methodology?: string;
  discipline?: string;
}

export type ResearchWorkspaceErrorCode =
  | 'research_bridge_unavailable'
  | 'research_project_list_unavailable'
  | 'research_snapshot_unavailable'
  | 'research_mutation_unavailable'
  | 'research_media_unavailable';

export interface ResearchWorkspaceError {
  code: ResearchWorkspaceErrorCode;
  operation:
    | 'load_projects'
    | 'load_snapshot'
    | 'create_project'
    | 'crud'
    | 'link'
    | 'review'
    | 'restore'
    | 'version'
    | 'checkpoint'
    | 'decision'
    | 'attach_media'
    | 'purge_media';
}

export interface ResearchWorkspaceLoadingState {
  projects: boolean;
  snapshot: boolean;
  mutation: boolean;
}

export type ResearchProjectListResult =
  | { success: true; projects: ResearchProjectDto[] }
  | { success: false; code: 'research_project_list_unavailable' };

export interface ResearchWorkspaceClient {
  listProjects(): Promise<ResearchProjectListResult>;
  getSnapshot(request: ResearchSnapshotRequest): Promise<ResearchSnapshotResult>;
  mutateCrud(request: ResearchCrudMutationRequest): Promise<ResearchMutationResult>;
  mutateLink(request: ResearchLinkMutationRequest): Promise<ResearchMutationResult>;
  mutateReview(request: ResearchReviewRequest): Promise<ResearchMutationResult>;
  mutateRestore(request: ResearchRestoreRequest): Promise<ResearchMutationResult>;
  mutateVersion(request: ResearchVersionMutationRequest): Promise<ResearchMutationResult>;
  mutateCheckpoint(request: ResearchCheckpointMutationRequest): Promise<ResearchMutationResult>;
  mutateDecision(request: ResearchDecisionMutationRequest): Promise<ResearchMutationResult>;
  attachMedia(request: ResearchMediaAttachRequest): Promise<ResearchMediaAttachResult>;
  purgeMedia(request: ResearchMediaPurgeRequest): Promise<ResearchMediaPurgeResult>;
}

type ResearchBridgeMethodName =
  | 'researchListProjects'
  | 'researchCrud'
  | 'researchSnapshot'
  | 'researchLink'
  | 'researchReview'
  | 'researchRestore'
  | 'researchVersion'
  | 'researchCheckpoint'
  | 'researchDecision'
  | 'researchMediaAttach'
  | 'researchMediaPurge';

type BridgeInvocation =
  | { available: true; value: unknown }
  | { available: false };

function isRecord(value: unknown): value is Record<string, unknown> {
  if (value === null || typeof value !== 'object') return false;
  try {
    if (Array.isArray(value)) return false;
    const prototype = Object.getPrototypeOf(value);
    return prototype === Object.prototype || prototype === null;
  } catch {
    return false;
  }
}

function getWindowMetisBridge(): Record<string, unknown> | undefined {
  if (typeof window === 'undefined') return undefined;
  try {
    const candidate = (window as unknown as { metis?: unknown }).metis;
    return isRecord(candidate) ? candidate : undefined;
  } catch {
    return undefined;
  }
}

async function invokeResearchBridge(
  methodName: ResearchBridgeMethodName,
  request: unknown,
): Promise<BridgeInvocation> {
  const bridge = getWindowMetisBridge();
  if (!bridge) return { available: false };
  try {
    const method = Reflect.get(bridge, methodName);
    if (typeof method !== 'function') return { available: false };
    const raw = Reflect.apply(method, bridge, [request]);
    return { available: true, value: await Promise.resolve(raw) };
  } catch {
    return { available: true, value: undefined };
  }
}

function projectListFromEntityResult(result: ResearchEntityListResult): ResearchProjectListResult {
  if (!result.success) return { success: false, code: 'research_project_list_unavailable' };
  const projects: ResearchProjectDto[] = [];
  for (const item of result.items) {
    if (item.entityKind !== 'project') {
      return { success: false, code: 'research_project_list_unavailable' };
    }
    projects.push(item.value);
  }
  return { success: true, projects };
}

function decodeProjectListPayload(input: unknown): ResearchProjectListResult {
  const current = decodeResearchEntityListResult(input);
  if (current.success) return projectListFromEntityResult(current);
  const legacy = decodeLegacyResearchEntityList('project', input);
  return projectListFromEntityResult(legacy);
}

async function invokeMutationBridge(
  methodName: Exclude<ResearchBridgeMethodName, 'researchListProjects' | 'researchSnapshot'>,
  request: unknown,
): Promise<ResearchMutationResult> {
  const invocation = await invokeResearchBridge(methodName, request);
  return invocation.available
    ? decodeResearchMutationResult(invocation.value)
    : createResearchMutationRecovery();
}

/**
 * Narrow, renderer-only adapter. It never assumes arbitrary methods exist on
 * window.metis and never reflects thrown IPC errors into application state.
 */
export function createWindowResearchWorkspaceClient(): ResearchWorkspaceClient {
  return {
    async listProjects() {
      const invocation = await invokeResearchBridge('researchListProjects', {
        includeDeleted: false,
        limit: 500,
        offset: 0,
      });
      return invocation.available
        ? decodeProjectListPayload(invocation.value)
        : { success: false, code: 'research_project_list_unavailable' };
    },
    async getSnapshot(request) {
      const decoded = decodeResearchSnapshotRequest(request);
      if (!decoded.ok) return createResearchSnapshotRecovery();
      const invocation = await invokeResearchBridge('researchSnapshot', decoded.value);
      return invocation.available
        ? decodeResearchSnapshotPayload(invocation.value)
        : createResearchSnapshotRecovery();
    },
    async mutateCrud(request) {
      const decoded = decodeResearchCrudRequest(request);
      if (!decoded.ok || !['create', 'update', 'delete'].includes(decoded.value.operation)) {
        return createResearchMutationRecovery();
      }
      return invokeMutationBridge('researchCrud', decoded.value);
    },
    async mutateLink(request) {
      const decoded = decodeResearchLinkRequest(request);
      if (!decoded.ok || decoded.value.operation === 'list_links') {
        return createResearchMutationRecovery();
      }
      return invokeMutationBridge('researchLink', decoded.value);
    },
    async mutateReview(request) {
      const decoded = decodeResearchReviewRequest(request);
      return decoded.ok
        ? invokeMutationBridge('researchReview', decoded.value)
        : createResearchMutationRecovery();
    },
    async mutateRestore(request) {
      const decoded = decodeResearchRestoreRequest(request);
      return decoded.ok
        ? invokeMutationBridge('researchRestore', decoded.value)
        : createResearchMutationRecovery();
    },
    async mutateVersion(request) {
      const decoded = decodeResearchVersionRequest(request);
      if (
        !decoded.ok
        || (decoded.value.operation !== 'save_version'
          && decoded.value.operation !== 'restore_version')
      ) {
        return createResearchMutationRecovery();
      }
      return invokeMutationBridge('researchVersion', decoded.value);
    },
    async mutateCheckpoint(request) {
      const decoded = decodeResearchCheckpointRequest(request);
      if (!decoded.ok || decoded.value.operation !== 'record_checkpoint') {
        return createResearchMutationRecovery();
      }
      return invokeMutationBridge('researchCheckpoint', decoded.value);
    },
    async mutateDecision(request) {
      const decoded = decodeResearchDecisionRequest(request);
      if (!decoded.ok || decoded.value.operation === 'list_decisions') {
        return createResearchMutationRecovery();
      }
      return invokeMutationBridge('researchDecision', decoded.value);
    },
    async attachMedia(request) {
      const invocation = await invokeResearchBridge('researchMediaAttach', request);
      return invocation.available
        ? decodeResearchMediaAttachResult(invocation.value)
        : createResearchMediaAttachFailure();
    },
    async purgeMedia(request) {
      const invocation = await invokeResearchBridge('researchMediaPurge', request);
      return invocation.available
        ? decodeResearchMediaPurgeResult(invocation.value)
        : createResearchMediaPurgeFailure();
    },
  };
}

function emptyLoading(): ResearchWorkspaceLoadingState {
  return { projects: false, snapshot: false, mutation: false };
}

function projectListError(): ResearchWorkspaceError {
  return { code: 'research_project_list_unavailable', operation: 'load_projects' };
}

function snapshotError(): ResearchWorkspaceError {
  return { code: 'research_snapshot_unavailable', operation: 'load_snapshot' };
}

function mutationError(
  operation: ResearchWorkspaceError['operation'],
  result?: ResearchMutationResult,
): ResearchWorkspaceError {
  return {
    code: result?.code === 'research_mutation_unavailable'
      ? 'research_bridge_unavailable'
      : 'research_mutation_unavailable',
    operation,
  };
}

function mediaError(
  operation: Extract<ResearchWorkspaceError['operation'], 'attach_media' | 'purge_media'>,
  result?: ResearchMediaAttachResult | ResearchMediaPurgeResult,
): ResearchWorkspaceError {
  return {
    code: result?.code === 'research_media_unavailable'
      ? 'research_bridge_unavailable'
      : 'research_media_unavailable',
    operation,
  };
}

function firstSelectionForSection(
  section: ResearchWorkspaceSection,
  snapshot: ProjectSnapshotRuntime | null,
): ResearchWorkspaceSelection {
  if (!snapshot) return null;
  switch (section) {
    case 'project':
      return { kind: 'project', id: snapshot.project.id };
    case 'sources': {
      const item = snapshot.sources.find((candidate) => candidate.deletedAt === null);
      return item ? { kind: 'source', id: item.id } : null;
    }
    case 'evidence': {
      const item = snapshot.evidence.find((candidate) => candidate.deletedAt === null);
      return item ? { kind: 'evidence', id: item.id } : null;
    }
    case 'note_codes': {
      const item = snapshot.noteCodes.find((candidate) => candidate.deletedAt === null);
      return item ? { kind: 'note_code', id: item.id } : null;
    }
    case 'claims': {
      const item = snapshot.claims.find((candidate) => candidate.deletedAt === null);
      return item ? { kind: 'claim', id: item.id } : null;
    }
    case 'artifacts': {
      const item = snapshot.artifacts.find((candidate) => candidate.deletedAt === null);
      return item ? { kind: 'artifact', id: item.id } : null;
    }
    case 'runs': {
      const item = snapshot.runs.find((candidate) => candidate.deletedAt === null);
      return item ? { kind: 'run', id: item.id } : null;
    }
    case 'recycle_bin': {
      const deletedSource = snapshot.sources.find((item) => item.deletedAt !== null);
      if (deletedSource) return { kind: 'source', id: deletedSource.id };
      const deletedEvidence = snapshot.evidence.find((item) => item.deletedAt !== null);
      if (deletedEvidence) return { kind: 'evidence', id: deletedEvidence.id };
      const deletedNote = snapshot.noteCodes.find((item) => item.deletedAt !== null);
      if (deletedNote) return { kind: 'note_code', id: deletedNote.id };
      const deletedClaim = snapshot.claims.find((item) => item.deletedAt !== null);
      if (deletedClaim) return { kind: 'claim', id: deletedClaim.id };
      const deletedArtifact = snapshot.artifacts.find((item) => item.deletedAt !== null);
      if (deletedArtifact) return { kind: 'artifact', id: deletedArtifact.id };
      return snapshot.project.deletedAt !== null
        ? { kind: 'project', id: snapshot.project.id }
        : null;
    }
    case 'goals':
      return null;
  }
}

function projectSort(a: ResearchProjectDto, b: ResearchProjectDto): number {
  return b.updatedAt - a.updatedAt || a.title.localeCompare(b.title);
}

export interface WorkspaceObjectTab {
  id: string;
  label: string;
  section: ResearchWorkspaceSection;
  entityId: string;
  dirty?: boolean;
}

export interface ResearchWorkspaceState {
  projects: ResearchProjectDto[];
  activeProjectId: string | null;
  snapshot: ProjectSnapshotRuntime | null;
  activeSection: ResearchWorkspaceSection;
  selection: ResearchWorkspaceSelection;
  projectQuery: string;
  loading: ResearchWorkspaceLoadingState;
  error: ResearchWorkspaceError | null;
  /**
   * 任务4 stale 语义：已有项目列表时刷新失败 → 保留旧列表并置 true，
   * UI 必须提示"当前显示上次成功加载的数据"；首次加载失败仍为 false
   * （此时 projects 为空、error 非 null → UI 呈 error + retry）。
   */
  projectsStale: boolean;
  lastMutation: ResearchMutationResult | null;
  isCreateProjectOpen: boolean;
  isRecycleBinOpen: boolean;

  // KIMI-201: multi-selection, global chrome state, and workspace object tabs.
  selectedIds: string[];
  isCommandBarOpen: boolean;
  isImportCreateOpen: boolean;
  workspaceObjectTabs: WorkspaceObjectTab[];
  activeObjectTabId: string | null;
  splitPreviewEnabled: boolean;
  splitPreviewSplit: number;
  versionDiffBaseId: string | null;
  versionDiffTargetId: string | null;

  setClient(client: ResearchWorkspaceClient): void;
  clearError(): void;
  setProjectQuery(query: string): void;
  setCreateProjectOpen(open: boolean): void;
  setRecycleBinOpen(open: boolean): void;
  setActiveSection(section: ResearchWorkspaceSection): void;
  selectItem(selection: ResearchWorkspaceSelection): void;
  loadProjects(): Promise<void>;
  setActiveProject(projectId: string | null): Promise<void>;
  refreshActiveProject(): Promise<void>;
  refreshWorkspace(): Promise<void>;
  createProject(input: ResearchProjectCreateInput): Promise<ResearchMutationResult>;
  applyCrud(request: ResearchCrudMutationRequest): Promise<ResearchMutationResult>;
  applyLink(request: ResearchLinkMutationRequest): Promise<ResearchMutationResult>;
  applyReview(request: ResearchReviewRequest): Promise<ResearchMutationResult>;
  applyRestore(request: ResearchRestoreRequest): Promise<ResearchMutationResult>;
  applyVersion(request: ResearchVersionMutationRequest): Promise<ResearchMutationResult>;
  applyCheckpoint(request: ResearchCheckpointMutationRequest): Promise<ResearchMutationResult>;
  applyDecision(request: ResearchDecisionMutationRequest): Promise<ResearchMutationResult>;

  // MEDIA-304 Phase B: managed image attach/purge.
  applyAttachMedia(request: ResearchMediaAttachRequest): Promise<ResearchMediaAttachResult>;
  applyPurgeMedia(request: ResearchMediaPurgeRequest): Promise<ResearchMediaPurgeResult>;

  // KIMI-201 workspace chrome actions.
  toggleSelectedId(id: string): void;
  clearSelectedIds(): void;
  setSelectedIds(ids: string[]): void;
  setCommandBarOpen(open: boolean): void;
  setImportCreateOpen(open: boolean): void;
  openWorkspaceObjectTab(tab: WorkspaceObjectTab): void;
  closeWorkspaceObjectTab(id: string): void;
  setActiveObjectTabId(id: string | null): void;
  reorderWorkspaceObjectTabs(fromIndex: number, toIndex: number): void;
  setSplitPreviewEnabled(enabled: boolean): void;
  setSplitPreviewSplit(split: number): void;
  setVersionDiffBaseId(id: string | null): void;
  setVersionDiffTargetId(id: string | null): void;
}

export function createResearchWorkspaceStore(
  initialClient: ResearchWorkspaceClient = createWindowResearchWorkspaceClient(),
): StoreApi<ResearchWorkspaceState> {
  let client = initialClient;
  let projectGeneration = 0;
  let snapshotGeneration = 0;

  return createStore<ResearchWorkspaceState>((set, get) => {
    const setLoading = (patch: Partial<ResearchWorkspaceLoadingState>) => {
      set((state) => ({ loading: { ...state.loading, ...patch } }));
    };

    const runMutation = async (
      operation: ResearchWorkspaceError['operation'],
      execute: () => Promise<ResearchMutationResult>,
      options: { refreshProjects?: boolean; refreshSnapshot?: boolean } = {},
    ): Promise<ResearchMutationResult> => {
      setLoading({ mutation: true });
      set({ error: null });
      let result: ResearchMutationResult;
      try {
        result = decodeResearchMutationResult(await execute());
      } catch {
        result = createResearchMutationRecovery();
      }
      set({ lastMutation: result });
      if (!result.success) {
        set({ error: mutationError(operation, result) });
        setLoading({ mutation: false });
        return result;
      }
      if (options.refreshProjects) await get().loadProjects();
      if (options.refreshSnapshot && get().activeProjectId) {
        await get().refreshActiveProject();
      }
      setLoading({ mutation: false });
      return result;
    };

    const runMediaMutation = async (
      operation: Extract<ResearchWorkspaceError['operation'], 'attach_media' | 'purge_media'>,
      execute: () => Promise<ResearchMediaAttachResult | ResearchMediaPurgeResult>,
      options: { refreshSnapshot?: boolean } = {},
    ): Promise<ResearchMediaAttachResult | ResearchMediaPurgeResult> => {
      setLoading({ mutation: true });
      set({ error: null });
      let result: ResearchMediaAttachResult | ResearchMediaPurgeResult;
      try {
        result = await execute();
      } catch {
        result = operation === 'attach_media'
          ? createResearchMediaAttachFailure()
          : createResearchMediaPurgeFailure();
      }
      if (!result.success) {
        set({ error: mediaError(operation, result) });
        setLoading({ mutation: false });
        return result;
      }
      if (options.refreshSnapshot && get().activeProjectId) {
        await get().refreshActiveProject();
      }
      setLoading({ mutation: false });
      return result;
    };

    return {
      projects: [],
      activeProjectId: null,
      snapshot: null,
      activeSection: 'project',
      selection: null,
      projectQuery: '',
      loading: emptyLoading(),
      error: null,
      projectsStale: false,
      lastMutation: null,
      isCreateProjectOpen: false,
      isRecycleBinOpen: false,

      // KIMI-201 initial chrome state.
      selectedIds: [],
      isCommandBarOpen: false,
      isImportCreateOpen: false,
      workspaceObjectTabs: [],
      activeObjectTabId: null,
      splitPreviewEnabled: false,
      splitPreviewSplit: 50,
      versionDiffBaseId: null,
      versionDiffTargetId: null,

      setClient(nextClient) {
        client = nextClient;
        projectGeneration += 1;
        snapshotGeneration += 1;
        set({ error: null, lastMutation: null });
      },
      clearError: () => set({ error: null }),
      setProjectQuery: (projectQuery) => set({ projectQuery }),
      setCreateProjectOpen: (isCreateProjectOpen) => set({ isCreateProjectOpen }),
      setRecycleBinOpen(isRecycleBinOpen) {
        set((state) => ({
          isRecycleBinOpen,
          activeSection: isRecycleBinOpen ? 'recycle_bin' : state.activeSection,
          selection: isRecycleBinOpen
            ? firstSelectionForSection('recycle_bin', state.snapshot)
            : state.selection,
        }));
      },
      setActiveSection(activeSection) {
        set((state) => ({
          activeSection,
          isRecycleBinOpen: activeSection === 'recycle_bin',
          selection: firstSelectionForSection(activeSection, state.snapshot),
        }));
      },
      selectItem: (selection) => set({ selection }),

      async loadProjects() {
        const generation = ++projectGeneration;
        setLoading({ projects: true });
        set({ error: null });
        let result: ResearchProjectListResult;
        try {
          result = await client.listProjects();
        } catch {
          result = { success: false, code: 'research_project_list_unavailable' };
        }
        if (generation !== projectGeneration) return;
        if (!result.success) {
          // 任务4 stale 语义：已有列表时刷新失败保留旧数据（stale notice 由
          // projectsStale 驱动）；首次加载失败保持空列表 + error（UI 呈 error+retry）。
          set((state) => ({
            projects: state.projects,
            error: projectListError(),
            projectsStale: state.projects.length > 0,
          }));
          setLoading({ projects: false });
          return;
        }
        const safeProjects = decodeLegacyResearchEntityList('project', result.projects);
        const normalizedProjects = projectListFromEntityResult(safeProjects);
        if (!normalizedProjects.success) {
          set((state) => ({
            projects: state.projects,
            error: projectListError(),
            projectsStale: state.projects.length > 0,
          }));
          setLoading({ projects: false });
          return;
        }
        const projects = [...normalizedProjects.projects].sort(projectSort);
        const previousActive = get().activeProjectId;
        const activeProjectId = previousActive
          && projects.some((project) => project.id === previousActive)
          ? previousActive
          : projects[0]?.id ?? null;
        set((state) => ({
          projects,
          activeProjectId,
          projectsStale: false,
          snapshot: state.snapshot?.project.id === activeProjectId ? state.snapshot : null,
          selection: state.snapshot?.project.id === activeProjectId
            ? state.selection
            : activeProjectId
              ? { kind: 'project', id: activeProjectId }
              : null,
        }));
        setLoading({ projects: false });
      },

      async setActiveProject(projectId) {
        snapshotGeneration += 1;
        set({
          activeProjectId: projectId,
          snapshot: null,
          activeSection: 'project',
          selection: projectId ? { kind: 'project', id: projectId } : null,
          isRecycleBinOpen: false,
          error: null,
        });
        await get().refreshActiveProject();
      },

      async refreshActiveProject() {
        const projectId = get().activeProjectId;
        if (!projectId) {
          set({ snapshot: null, selection: null });
          return;
        }
        const generation = ++snapshotGeneration;
        setLoading({ snapshot: true });
        set({ error: null });
        let result: ResearchSnapshotResult;
        try {
          result = decodeResearchSnapshotPayload(
            await client.getSnapshot({ operation: 'snapshot', projectId }),
          );
        } catch {
          result = createResearchSnapshotRecovery();
        }
        if (generation !== snapshotGeneration || get().activeProjectId !== projectId) return;
        if (!result.success) {
          // Preserve the existing snapshot on refresh failure — a stale
          // snapshot is safer than wiping the UI state (e.g. strict decode
          // of a legacy payload should not blank the workspace).
          set((state) => ({ snapshot: state.snapshot ?? null, error: snapshotError() }));
          setLoading({ snapshot: false });
          return;
        }
        set((state) => ({
          snapshot: result.snapshot,
          selection: state.selection
            ?? firstSelectionForSection(state.activeSection, result.snapshot),
        }));
        setLoading({ snapshot: false });
      },

      async refreshWorkspace() {
        await get().loadProjects();
        if (get().activeProjectId) await get().refreshActiveProject();
      },

      async createProject(input) {
        const request: Extract<
          ResearchCrudMutationRequest,
          { operation: 'create'; entityKind: 'project' }
        > = {
          operation: 'create',
          entityKind: 'project',
          projectId: input.projectId,
          value: {
            title: input.title,
            originalIntent: input.originalIntent ?? '',
            researchQuestion: input.researchQuestion ?? '',
            lifecycle: 'draft',
            methodology: input.methodology ?? '',
            discipline: input.discipline ?? '',
          },
        };
        const result = await runMutation(
          'create_project',
          () => client.mutateCrud(request),
          { refreshProjects: true },
        );
        if (result.success) {
          set({ isCreateProjectOpen: false });
          await get().setActiveProject(result.resourceId);
        }
        return result;
      },

      applyCrud(request) {
        const affectsProjectList = request.entityKind === 'project';
        return runMutation('crud', () => client.mutateCrud(request), {
          refreshProjects: affectsProjectList,
          refreshSnapshot: true,
        });
      },
      applyLink(request) {
        return runMutation('link', () => client.mutateLink(request), {
          refreshSnapshot: true,
        });
      },
      applyReview(request) {
        return runMutation('review', () => client.mutateReview(request), {
          refreshSnapshot: true,
        });
      },
      applyRestore(request) {
        return runMutation('restore', () => client.mutateRestore(request), {
          refreshProjects: request.entityKind === 'project',
          refreshSnapshot: true,
        });
      },
      applyVersion(request) {
        return runMutation('version', () => client.mutateVersion(request), {
          refreshSnapshot: true,
        });
      },
      applyCheckpoint(request) {
        return runMutation('checkpoint', () => client.mutateCheckpoint(request), {
          refreshSnapshot: true,
        });
      },
      applyDecision(request) {
        return runMutation('decision', () => client.mutateDecision(request), {
          refreshSnapshot: true,
        });
      },

      // MEDIA-304 Phase B: managed image attach/purge.
      async applyAttachMedia(request) {
        const result = await runMediaMutation('attach_media', () => client.attachMedia(request), {
          refreshSnapshot: true,
        }) as ResearchMediaAttachResult;
        if (result.success && get().activeProjectId === request.projectId) {
          set((state) => {
            if (!state.snapshot) return {};
            const now = Date.now();
            const newSource = {
              id: request.sourceId,
              projectId: request.projectId,
              kind: 'image' as const,
              title: request.caption,
              authors: [] as string[],
              year: null as number | null,
              venue: '' as string,
              identifier: '' as string,
              identifierType: 'other' as const,
              externalUrl: null as string | null,
              tags: [] as string[],
              sourceVersionHash: null as string | null,
              deliverableSourceKind: null,
              deliverableRuleKind: null,
              createdAt: now,
              updatedAt: now,
              deletedAt: null as number | null,
            };
            return {
              snapshot: {
                ...state.snapshot,
                sources: [...state.snapshot.sources, newSource],
              },
              selection: { kind: 'source' as const, id: request.sourceId },
              activeSection: 'sources' as const,
            };
          });
        }
        return result;
      },
      async applyPurgeMedia(request) {
        const result = await runMediaMutation('purge_media', () => client.purgeMedia(request), {
          refreshSnapshot: true,
        }) as ResearchMediaPurgeResult;
        if (result.success && get().activeProjectId === request.projectId) {
          set((state) => ({
            snapshot: state.snapshot
              ? {
                  ...state.snapshot,
                  sources: state.snapshot.sources.filter(
                    (source) => source.id !== request.sourceId,
                  ),
                }
              : null,
            selection: state.selection?.kind === 'source'
              && state.selection.id === request.sourceId
              ? null
              : state.selection,
            selectedIds: state.selectedIds.filter((id) => id !== request.sourceId),
          }));
        }
        return result;
      },

      // KIMI-201 workspace chrome actions.
      toggleSelectedId(id) {
        set((state) => {
          const exists = state.selectedIds.includes(id);
          const next = exists
            ? state.selectedIds.filter((candidate) => candidate !== id)
            : [...state.selectedIds, id];
          return { selectedIds: next };
        });
      },
      clearSelectedIds: () => set({ selectedIds: [] }),
      setSelectedIds: (ids) => set({ selectedIds: ids }),
      setCommandBarOpen: (isCommandBarOpen) => set({ isCommandBarOpen }),
      setImportCreateOpen: (isImportCreateOpen) => set({ isImportCreateOpen }),
      openWorkspaceObjectTab(tab) {
        set((state) => {
          const exists = state.workspaceObjectTabs.some((t) => t.id === tab.id);
          const tabs = exists ? state.workspaceObjectTabs : [...state.workspaceObjectTabs, tab];
          return {
            workspaceObjectTabs: tabs,
            activeObjectTabId: tab.id,
          };
        });
      },
      closeWorkspaceObjectTab(id) {
        set((state) => {
          const tabs = state.workspaceObjectTabs.filter((t) => t.id !== id);
          const nextActive = state.activeObjectTabId === id
            ? tabs[tabs.length - 1]?.id ?? null
            : state.activeObjectTabId;
          return {
            workspaceObjectTabs: tabs,
            activeObjectTabId: nextActive,
          };
        });
      },
      setActiveObjectTabId: (activeObjectTabId) => set({ activeObjectTabId }),
      reorderWorkspaceObjectTabs(fromIndex, toIndex) {
        set((state) => {
          const tabs = [...state.workspaceObjectTabs];
          const [moved] = tabs.splice(fromIndex, 1);
          if (!moved) return { workspaceObjectTabs: tabs };
          tabs.splice(toIndex, 0, moved);
          return { workspaceObjectTabs: tabs };
        });
      },
      setSplitPreviewEnabled: (splitPreviewEnabled) => set({ splitPreviewEnabled }),
      setSplitPreviewSplit: (splitPreviewSplit) => set({ splitPreviewSplit }),
      setVersionDiffBaseId: (versionDiffBaseId) => set({ versionDiffBaseId }),
      setVersionDiffTargetId: (versionDiffTargetId) => set({ versionDiffTargetId }),
    };
  });
}

export const researchWorkspaceStore = createResearchWorkspaceStore();

export function useResearchWorkspaceStore<T>(
  selector: (state: ResearchWorkspaceState) => T,
): T {
  return useStore(researchWorkspaceStore, selector);
}
