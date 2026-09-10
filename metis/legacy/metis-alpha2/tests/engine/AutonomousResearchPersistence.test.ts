import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import {
  applyAutonomousResearchEvent,
  beginAutonomousResearchRun,
  createAutonomousResearchArtifactSink,
  ensureAutonomousResearchProject,
} from '../../engine/research/AutonomousResearchPersistence.js';
import type { Project } from '../../engine/persistence/researchModel.js';

function project(id: string): Project {
  return {
    id,
    title: '已有项目',
    originalIntent: '研究目标',
    researchQuestion: '问题',
    lifecycle: 'draft',
    methodology: '',
    discipline: '社会学',
    metadata: {},
    createdAt: 1,
    updatedAt: 1,
    archivedAt: null,
    version: 1,
    source: 'user',
    deletedAt: null,
  };
}

describe('autonomous research project/run persistence bridge', () => {
  let dataDir: string;
  let store: PersistenceStore;
  let repository: ResearchRepository;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-auto-persistence-'));
    store = new PersistenceStore(path.join(dataDir, 'test.db'));
    repository = new ResearchRepository(store.raw);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('creates an exploration project automatically instead of asking for project confirmation', () => {
    const result = ensureAutonomousResearchProject(repository, {
      goal: '利用地方档案研究城市救济制度的演变',
      generateId: () => 'project-auto-1',
      now: () => 100,
    });

    expect(result).toEqual({ projectId: 'project-auto-1', created: true });
    const saved = repository.getProject('project-auto-1');
    expect(saved?.originalIntent).toBe('利用地方档案研究城市救济制度的演变');
    expect(saved?.lifecycle).toBe('running');
    expect(saved?.metadata.explorationSandbox).toBe(true);
  });

  it('reuses a requested project and rejects a missing project id', () => {
    repository.createProject(project('project-existing'));

    expect(ensureAutonomousResearchProject(repository, {
      goal: '目标',
      requestedProjectId: 'project-existing',
    })).toEqual({ projectId: 'project-existing', created: false });
    expect(ensureAutonomousResearchProject(repository, {
      goal: '目标',
      requestedProjectId: 'project-missing',
    })).toBeUndefined();
  });

  it('mirrors method, phase and terminal state into the durable research run', () => {
    repository.createProject(project('project-existing'));
    beginAutonomousResearchRun(repository, {
      sessionId: 'session-1',
      projectId: 'project-existing',
      goal: '研究目标',
      now: () => 100,
    });

    applyAutonomousResearchEvent(repository, 'project-existing', {
      type: 'engine-started',
      sessionId: 'session-1',
      goal: '研究目标',
      plan: [
        { phase: 'source_discovery', name: '资料发现' },
        { phase: 'source_criticism', name: '史料批判' },
      ],
      method: {
        family: 'historical',
        name: '历史研究',
        rationale: '问题关注历时变化。',
        confidence: 0.9,
        selectedBy: 'automatic_heuristic',
      },
    }, () => 110);
    applyAutonomousResearchEvent(repository, 'project-existing', {
      type: 'phase-started',
      sessionId: 'session-1',
      phase: 'source_discovery',
      phaseIteration: 1,
      phaseName: '资料发现',
    }, () => 120);

    const running = repository.getRun('session-1');
    expect(running?.status).toBe('running');
    expect(running?.currentStepId).toBe('source_discovery');
    expect(running?.plan.method).toMatchObject({ family: 'historical', name: '历史研究' });
    expect(repository.getProject('project-existing')?.methodology).toBe('历史研究');

    applyAutonomousResearchEvent(repository, 'project-existing', {
      type: 'engine-failed',
      sessionId: 'session-1',
      reason: '资料渠道不可用',
      completedPhases: 1,
      recoverable: true,
    }, () => 130);

    const failed = repository.getRun('session-1');
    expect(failed?.status).toBe('failed');
    expect(failed?.completedAt).toBeNull();
    expect(failed?.plan.failureReason).toBe('资料渠道不可用');
  });

  it('persists autonomous phase outputs as versioned draft artifacts with lineage', async () => {
    repository.createProject(project('project-existing'));
    beginAutonomousResearchRun(repository, {
      sessionId: 'session-artifacts',
      projectId: 'project-existing',
      goal: '研究地方档案中的救济制度变迁',
      now: () => 100,
    });
    const sink = createAutonomousResearchArtifactSink(repository, () => 200);

    const sourceArtifactId = await sink.persistPhaseOutput({
      sessionId: 'session-artifacts',
      projectId: 'project-existing',
      goal: '研究地方档案中的救济制度变迁',
      phase: 'source_discovery',
      phaseName: '资料发现',
      iteration: 1,
      output: '# 资料清单\n\n已找到三组可核查档案。',
    });
    await sink.persistPhaseOutput({
      sessionId: 'session-artifacts',
      projectId: 'project-existing',
      goal: '研究地方档案中的救济制度变迁',
      phase: 'source_discovery',
      phaseName: '资料发现（自主重做）',
      iteration: 2,
      output: '# 修订资料清单\n\n补充了档案形成背景与缺失范围。',
    });
    const writingArtifactId = await sink.persistPhaseOutput({
      sessionId: 'session-artifacts',
      projectId: 'project-existing',
      goal: '研究地方档案中的救济制度变迁',
      phase: 'writing',
      phaseName: '研究写作',
      iteration: 1,
      output: '# 研究报告\n\n这是综合后的研究结论。',
    });

    expect(sourceArtifactId).not.toBe(writingArtifactId);
    expect(repository.getArtifact(sourceArtifactId)).toMatchObject({
      projectId: 'project-existing',
      artifactType: 'report',
      reviewStatus: 'draft',
      version: 2,
    });
    expect(repository.listArtifactVersions(sourceArtifactId)).toHaveLength(2);
    expect(repository.getArtifactVersion(sourceArtifactId)?.content).toContain('修订资料清单');
    expect(repository.getArtifactVersion(sourceArtifactId)?.createdBy).toBe('ai');

    const writing = repository.getArtifact(writingArtifactId);
    expect(writing).toMatchObject({ artifactType: 'manuscript', reviewStatus: 'draft' });
    const writingVersion = repository.getArtifactVersion(writingArtifactId);
    expect(writingVersion?.manifest).toMatchObject({
      inputs: [{ kind: 'previous_artifact', id: sourceArtifactId }],
      generatedBy: {
        capabilityId: 'autonomous_research',
        codeRef: 'autonomous-session:session-artifacts',
      },
    });
    expect(await sink.listArtifactIds('session-artifacts', 'project-existing'))
      .toEqual([sourceArtifactId, writingArtifactId]);
    expect(repository.getRun('session-artifacts')?.plan.phaseArtifacts).toMatchObject({
      source_discovery: { artifactId: sourceArtifactId, version: 2 },
      writing: { artifactId: writingArtifactId, version: 1 },
    });
    await sink.finalizeRun?.(
      'session-artifacts',
      'project-existing',
      '研究完成。',
      [sourceArtifactId, writingArtifactId],
    );
    expect(repository.getRun('session-artifacts')).toMatchObject({
      status: 'completed',
      completedAt: 200,
      plan: { summary: '研究完成。', artifactIds: [sourceArtifactId, writingArtifactId] },
    });
  });

  it('does not erase durable artifact ids when the completion event is sparse', async () => {
    repository.createProject(project('project-existing'));
    beginAutonomousResearchRun(repository, {
      sessionId: 'session-complete',
      projectId: 'project-existing',
      goal: '研究目标',
      now: () => 100,
    });
    const sink = createAutonomousResearchArtifactSink(repository, () => 200);
    const artifactId = await sink.persistPhaseOutput({
      sessionId: 'session-complete',
      projectId: 'project-existing',
      goal: '研究目标',
      phase: 'synthesis',
      phaseName: '综合解释',
      iteration: 1,
      output: '综合结论',
    });

    applyAutonomousResearchEvent(repository, 'project-existing', {
      type: 'engine-completed',
      sessionId: 'session-complete',
      summary: '完成',
      artifactIds: [],
    }, () => 300);

    expect(repository.getRun('session-complete')).toMatchObject({
      status: 'completed',
      completedAt: 300,
      plan: { artifactIds: [artifactId] },
    });
  });
});
