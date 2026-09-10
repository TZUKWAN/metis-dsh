/**
 * ResearchJournalService — 跨会话研究连续性（T27）。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { ResearchJournalService } from '../../electron/ResearchJournalService.js';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import { GoalEngine } from '../../engine/goal/GoalEngine.js';

let tmpDir: string;
let store: PersistenceStore;
let repository: ResearchRepository;
let goals: GoalEngine;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-journal-'));
  store = new PersistenceStore(path.join(tmpDir, 'test.db'));
  repository = new ResearchRepository(store.raw);
  goals = new GoalEngine(null as never, undefined, {
    loadGoals: () => [],
    loadArchives: () => [],
    saveGoal: () => {},
    savePlan: () => {},
    saveRun: () => {},
    saveArchive: () => {},
  } as never);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

function makeProject(id: string, title: string) {
  const now = Date.now();
  return {
    id, title,
    originalIntent: '',
    researchQuestion: '',
    lifecycle: 'draft' as const,
    methodology: '',
    discipline: '',
    metadata: {},
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
    source: 'user' as const,
    deletedAt: null,
  };
}

describe('ResearchJournalService', () => {
  it('项目不存在时返回 null', () => {
    const service = new ResearchJournalService(repository, goals, store);
    expect(service.buildResumeBrief('no-such-project')).toBeNull();
  });

  it('空项目给出"还没有研究活动记录"摘要', () => {
    repository.createProject(makeProject('p-j-1', '空项目'));
    const service = new ResearchJournalService(repository, goals, store);
    const brief = service.buildResumeBrief('p-j-1')!;
    expect(brief).not.toBeNull();
    expect(brief.summaryText).toContain('还没有研究活动记录');
    expect(brief.lastActivityAt).toBeNull();
  });

  it('聚合任务、文献与 run 生成中文进展摘要', () => {
    repository.createProject(makeProject('p-j-2', '活动项目'));
    const created = goals.createGoal('完成文献综述矩阵', '测试', 'p-j-2');
    expect(created.projectId).toBe('p-j-2');
    store.savePaper({
      id: 'paper-j-1',
      title: '乡村振兴与基层治理',
      authors: [], year: 2024, venue: '', abstract: '',
      tags: [], notes: '', readStatus: 'unread', rating: 0,
      addedAt: Date.now(), projectId: 'p-j-2',
    });
    const service = new ResearchJournalService(repository, goals, store);
    const brief = service.buildResumeBrief('p-j-2')!;
    expect(brief.openTasks).toBeGreaterThanOrEqual(1);
    expect(brief.paperCount).toBe(1);
    expect(brief.summaryText).toContain('最新文献');
    expect(brief.summaryText).toContain('乡村振兴');
    expect(brief.lastActivityAt).not.toBeNull();
  });

  it('run 状态映射到中文', () => {
    repository.createProject(makeProject('p-j-3', 'run 项目'));
    store.raw.prepare(
      'INSERT INTO research_runs (id, project_id, status, plan, provider_profile, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?, ?)',
    ).run('run-1', 'p-j-3', 'completed', '{}', '{}', Date.now() - 1000, Date.now());
    const service = new ResearchJournalService(repository, goals, store);
    const brief = service.buildResumeBrief('p-j-3')!;
    expect(brief.lastRunStatus).toBe('completed');
    expect(brief.summaryText).toContain('已完成');
  });
});
