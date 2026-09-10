/**
 * METIS-406 — Project context continuity tests.
 *
 * Verifies: context survives mode switches (read→write, analyze→converse); decisions /
 * research question / methodology / sources / artifacts are shared; continuity check works.
 */

import { describe, it, expect } from 'vitest';
import { ProjectContextService, type ProjectContextStore, type ProjectContextState } from './ProjectContextService.js';
import type { Project, ResearchArtifact } from '../persistence/researchModel.js';

class MemPCStore implements ProjectContextStore {
  ctx = new Map<string, ProjectContextState>();
  projects = new Map<string, Project>();
  artifacts = new Map<string, ResearchArtifact[]>();
  load(pid: string) { const s = this.ctx.get(pid); return s ? { ...s, activeSourceIds: [...s.activeSourceIds], recentDecisions: [...s.recentDecisions], artifactIds: [...s.artifactIds] } : undefined; }
  save(s: ProjectContextState) { this.ctx.set(s.project.id, { ...s, activeSourceIds: [...s.activeSourceIds], recentDecisions: [...s.recentDecisions], artifactIds: [...s.artifactIds] }); }
  getProject(pid: string) { return this.projects.get(pid); }
  listArtifacts(pid: string) { return this.artifacts.get(pid) ?? []; }
}

function makeProject(id: string): Project {
  const now = Date.now();
  return {
    id, title: `项目 ${id}`, originalIntent: '意图', researchQuestion: '', lifecycle: 'draft',
    methodology: '', discipline: '', metadata: {}, createdAt: now, updatedAt: now,
    archivedAt: null, version: 1, source: 'user', deletedAt: null,
  };
}

describe('METIS-406 ProjectContextService — shared state across modes', () => {
  it('init creates a context; subsequent get returns the same state', () => {
    const svc = new ProjectContextService(new MemPCStore());
    const p = makeProject('p1');
    const s = svc.init(p);
    expect(s.project.id).toBe('p1');
    expect(svc.get('p1')?.project.id).toBe('p1');
  });

  it('setResearchQuestion is visible to all modes (continuity)', () => {
    const svc = new ProjectContextService(new MemPCStore());
    svc.init(makeProject('p1'));
    svc.setResearchQuestion('p1', '科举对社会流动的影响');
    expect(svc.get('p1')?.researchQuestion).toBe('科举对社会流动的影响');
    expect(svc.hasContinuityFor('p1', 'converse')).toBe(true);
  });

  it('activateSource makes read/analyze modes continuous', () => {
    const svc = new ProjectContextService(new MemPCStore());
    svc.init(makeProject('p1'));
    expect(svc.hasContinuityFor('p1', 'read')).toBe(false);
    svc.activateSource('p1', 'src-1');
    expect(svc.hasContinuityFor('p1', 'read')).toBe(true);
    expect(svc.hasContinuityFor('p1', 'analyze')).toBe(true);
  });

  it('registerArtifact makes write mode continuous', () => {
    const svc = new ProjectContextService(new MemPCStore());
    svc.init(makeProject('p1'));
    svc.setResearchQuestion('p1', 'q'); // write also accepts research question
    expect(svc.hasContinuityFor('p1', 'write')).toBe(true);
    svc.registerArtifact('p1', 'art-1');
    expect(svc.get('p1')?.artifactIds).toContain('art-1');
  });
});

describe('METIS-406 ProjectContextService — decisions & task', () => {
  it('records decisions newest-first and bounds the working set', () => {
    const svc = new ProjectContextService(new MemPCStore());
    svc.init(makeProject('p1'));
    for (let i = 0; i < 25; i++) {
      svc.recordDecision('p1', { id: `d${i}`, text: `决策${i}`, at: 1000 + i });
    }
    const s = svc.get('p1')!;
    expect(s.recentDecisions.length).toBeLessThanOrEqual(20);
    expect(s.recentDecisions[0]?.id).toBe('d24'); // newest first
  });

  it('sets and replaces the current task', () => {
    const svc = new ProjectContextService(new MemPCStore());
    svc.init(makeProject('p1'));
    svc.setCurrentTask('p1', { id: 't1', description: '写综述', status: 'in_progress', createdAt: Date.now() });
    expect(svc.get('p1')?.currentTask?.description).toBe('写综述');
    svc.setCurrentTask('p1', { id: 't2', description: '检查引用', status: 'pending', createdAt: Date.now() });
    expect(svc.get('p1')?.currentTask?.description).toBe('检查引用');
  });
});

describe('METIS-406 ProjectContextService — mode-switch continuity', () => {
  it('a full project has continuity for all four modes', () => {
    const svc = new ProjectContextService(new MemPCStore());
    svc.init(makeProject('p1'));
    svc.setResearchQuestion('p1', 'q');
    svc.activateSource('p1', 's1');
    svc.registerArtifact('p1', 'a1');
    for (const mode of ['converse', 'read', 'analyze', 'write'] as const) {
      expect(svc.hasContinuityFor('p1', mode), `${mode} should be continuous`).toBe(true);
    }
  });

  it('mutate throws if context was never initialized (defensive)', () => {
    const svc = new ProjectContextService(new MemPCStore());
    expect(() => svc.setResearchQuestion('never-inited', 'q')).toThrow(/No context/);
  });
});
