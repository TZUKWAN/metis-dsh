/**
 * 批1/批3：项目归档-恢复生命周期、软删、AI 阶段判定。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import { detectStage } from '../../engine/research/StageDetector.js';
import { canTransitionResearchLifecycle } from '../../engine/core/types.js';

let tmpDir: string;
let store: PersistenceStore;
let repository: ResearchRepository;

function makeProject(id: string, title: string) {
  const now = Date.now();
  return {
    id, title,
    originalIntent: '', researchQuestion: '', lifecycle: 'draft' as const,
    methodology: '', discipline: '', metadata: {},
    createdAt: now, updatedAt: now, archivedAt: null,
    version: 1, source: 'user' as const, deletedAt: null,
  };
}

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-archive-'));
  store = new PersistenceStore(path.join(tmpDir, 'test.db'));
  repository = new ResearchRepository(store.raw);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('项目归档-恢复生命周期（批1）', () => {
  it('归档后 archived 状态可恢复（状态机扩展）', () => {
    expect(canTransitionResearchLifecycle('archived', 'draft')).toBe(true);
    expect(canTransitionResearchLifecycle('archived', 'completed')).toBe(true);
    expect(canTransitionResearchLifecycle('archived', 'running')).toBe(false);
  });

  it('归档→恢复完整往返（归档前记忆原生命周期）', () => {
    const project = repository.createProject(makeProject('p-arc-1', '归档测试'))!;
    const archived = repository.updateProject('p-arc-1', {
      lifecycle: 'archived',
      metadata: { ...project.metadata, preArchiveLifecycle: project.lifecycle },
    })!;
    expect(archived.lifecycle).toBe('archived');
    expect(archived.archivedAt).not.toBeNull();

    const restored = repository.updateProject('p-arc-1', {
      lifecycle: 'draft',
      metadata: { ...archived.metadata, preArchiveLifecycle: undefined },
    })!;
    expect(restored.lifecycle).toBe('draft');
    expect(restored.archivedAt).toBeNull();
  });

  it('软删项目后从默认列表消失，可含删除查询', () => {
    repository.createProject(makeProject('p-del-1', '待删'))!;
    expect(repository.listProjects().some((p) => p.id === 'p-del-1')).toBe(true);
    expect(repository.softDeleteProject('p-del-1')).toBe(true);
    expect(repository.listProjects().some((p) => p.id === 'p-del-1')).toBe(false);
    expect(repository.listProjects({ includeDeleted: true }).some((p) => p.id === 'p-del-1')).toBe(true);
  });
});

describe('AI 阶段判定（批3）', () => {
  it('空项目 → 选题阶段', () => {
    const result = detectStage({
      paperCount: 0, paperWithPdfCount: 0, completedTasks: 0, openTasks: 0,
      artifactCount: 0, noteCodeCount: 0, transcriptCount: 0,
      researchQuestionFilled: false, lastRunStatus: null, submissionCount: 0,
    });
    expect(result.stage).toBe('topic');
  });

  it('有文献无全文 → 文献阶段；研究问题明确且任务过半 → 设计阶段', () => {
    const withPapers = detectStage({
      paperCount: 6, paperWithPdfCount: 0, completedTasks: 1, openTasks: 3,
      artifactCount: 0, noteCodeCount: 0, transcriptCount: 0,
      researchQuestionFilled: false, lastRunStatus: null, submissionCount: 0,
    });
    expect(withPapers.stage).toBe('literature');

    const advanced = detectStage({
      paperCount: 6, paperWithPdfCount: 0, completedTasks: 3, openTasks: 2,
      artifactCount: 0, noteCodeCount: 0, transcriptCount: 0,
      researchQuestionFilled: true, lastRunStatus: null, submissionCount: 0,
    });
    expect(advanced.stage).toBe('design');
  });

  it('有全文文献 → 设计阶段；有编码/转写/完成 run → 分析阶段', () => {
    const withFullText = detectStage({
      paperCount: 4, paperWithPdfCount: 3, completedTasks: 0, openTasks: 2,
      artifactCount: 0, noteCodeCount: 0, transcriptCount: 0,
      researchQuestionFilled: true, lastRunStatus: null, submissionCount: 0,
    });
    expect(withFullText.stage).toBe('design');

    const analyzing = detectStage({
      paperCount: 6, paperWithPdfCount: 4, completedTasks: 2, openTasks: 3,
      artifactCount: 0, noteCodeCount: 12, transcriptCount: 2,
      researchQuestionFilled: true, lastRunStatus: 'completed', submissionCount: 0,
    });
    expect(analyzing.stage).toBe('analysis');
  });

  it('多成果 → 写作阶段；有投稿 → 修订阶段', () => {
    const writing = detectStage({
      paperCount: 8, paperWithPdfCount: 6, completedTasks: 4, openTasks: 1,
      artifactCount: 3, noteCodeCount: 10, transcriptCount: 1,
      researchQuestionFilled: true, lastRunStatus: 'completed', submissionCount: 0,
    });
    expect(writing.stage).toBe('writing');

    const revising = detectStage({
      paperCount: 8, paperWithPdfCount: 6, completedTasks: 5, openTasks: 0,
      artifactCount: 2, noteCodeCount: 10, transcriptCount: 1,
      researchQuestionFilled: true, lastRunStatus: 'completed', submissionCount: 1,
    });
    expect(revising.stage).toBe('revision');
  });
});
