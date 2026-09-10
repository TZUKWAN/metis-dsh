/**
 * 任务4 第三/十四节 —— researchWorkspaceStore 的 stale 语义。
 *
 * - 首次 loadProjects 失败 → projects 为空 + error（UI 呈 error + retry，绝不冒充空列表）；
 * - 已有列表时刷新失败 → 旧列表保留 + projectsStale=true（UI 呈 stale notice）；
 * - 再次成功 → projectsStale 复位。
 */

import { describe, it, expect, vi } from 'vitest';
import {
  createResearchWorkspaceStore,
  type ResearchWorkspaceClient,
  type ResearchWorkspaceState,
} from '../../src/research/researchWorkspaceStore.js';
import type { ProjectSnapshotRuntime, ResearchProjectDto } from '../../engine/runtime/ResearchRuntimeContract.js';
import type { ResearchMediaAttachResult, ResearchMediaPurgeResult } from '../../engine/runtime/ResearchMediaRuntimeContract.js';

function makeProject(id: string): ResearchProjectDto {
  return {
    id,
    title: `项目 ${id}`,
    researchQuestion: '',
    originalIntent: '',
    lifecycle: 'draft',
    methodology: '',
    discipline: '',
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_100_000,
    deletedAt: null,
    archivedAt: null,
    version: 1,
  } as unknown as ResearchProjectDto;
}

function makeClient(listProjects: ResearchWorkspaceClient['listProjects']): ResearchWorkspaceClient {
  const snapshot = { project: makeProject('project-1') } as unknown as ProjectSnapshotRuntime;
  const mutationFailure = { success: false, code: 'research_mutation_unavailable' } as const;
  return {
    listProjects,
    getSnapshot: vi.fn(async () => ({ success: true, snapshot })),
    mutateCrud: vi.fn(async () => mutationFailure),
    mutateLink: vi.fn(async () => mutationFailure),
    mutateReview: vi.fn(async () => mutationFailure),
    mutateRestore: vi.fn(async () => mutationFailure),
    mutateVersion: vi.fn(async () => mutationFailure),
    mutateCheckpoint: vi.fn(async () => mutationFailure),
    mutateDecision: vi.fn(async () => mutationFailure),
    attachMedia: vi.fn(async (): Promise<ResearchMediaAttachResult> => ({ success: false, code: 'research_media_unavailable' })),
    purgeMedia: vi.fn(async (): Promise<ResearchMediaPurgeResult> => ({ success: false, code: 'research_media_unavailable' })),
  };
}

function pick(state: ResearchWorkspaceState) {
  return { count: state.projects.length, error: state.error, stale: state.projectsStale };
}

describe('researchWorkspaceStore —— 列表加载 stale 语义（任务4）', () => {
  it('首次加载失败：projects 保持为空 + error，projectsStale=false', async () => {
    const store = createResearchWorkspaceStore(makeClient(async () => ({ success: false, code: 'research_project_list_unavailable' })));
    await store.getState().loadProjects();
    const { count, error, stale } = pick(store.getState());
    expect(count).toBe(0);
    expect(error).toEqual({ code: 'research_project_list_unavailable', operation: 'load_projects' });
    expect(stale).toBe(false);
  });

  it('已有列表刷新失败：旧列表保留 + projectsStale=true', async () => {
    const projects = [makeProject('project-1'), makeProject('project-2')];
    let failNext = false;
    const store = createResearchWorkspaceStore(makeClient(async () => {
      if (failNext) return { success: false, code: 'research_project_list_unavailable' };
      return { success: true, projects };
    }));

    await store.getState().loadProjects();
    expect(pick(store.getState())).toEqual({ count: 2, error: null, stale: false });

    failNext = true;
    await store.getState().loadProjects();
    const { count, error, stale } = pick(store.getState());
    expect(count).toBe(2); // 旧数据保留，不清空
    expect(error).toEqual({ code: 'research_project_list_unavailable', operation: 'load_projects' });
    expect(stale).toBe(true); // UI 据此显示“当前显示上次成功加载的数据”
  });

  it('stale 后重新成功：projectsStale 复位为 false', async () => {
    const projects = [makeProject('project-1')];
    let failNext = true;
    const store = createResearchWorkspaceStore(makeClient(async () => {
      if (failNext) return { success: false, code: 'research_project_list_unavailable' };
      return { success: true, projects };
    }));

    await store.getState().loadProjects();
    expect(store.getState().projectsStale).toBe(false);
    expect(store.getState().error).not.toBeNull();

    failNext = false;
    await store.getState().loadProjects();
    expect(store.getState().projectsStale).toBe(false);
    expect(store.getState().projects.length).toBe(1);
    expect(store.getState().error).toBeNull();
  });
});
