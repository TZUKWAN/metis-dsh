import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import type { Evidence, Project, Source } from '../../engine/persistence/researchModel.js';
import { createProjectResearchToolHandlers } from '../../engine/tools/builtin/ProjectResearchTools.js';

describe('project-scoped autonomous research tools', () => {
  let dataDir: string;
  let store: PersistenceStore;
  let repository: ResearchRepository;

  beforeEach(() => {
    dataDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-project-tools-'));
    store = new PersistenceStore(path.join(dataDir, 'test.db'));
    repository = new ResearchRepository(store.raw);
    const project: Project = {
      id: 'p1', title: '地方救济史', originalIntent: '研究制度变迁', researchQuestion: '制度如何变化？',
      lifecycle: 'running', methodology: '历史研究', discipline: '历史学', metadata: {}, createdAt: 1,
      updatedAt: 1, archivedAt: null, version: 1, source: 'user', deletedAt: null,
    };
    repository.createProject(project);
    repository.createProject({ ...project, id: 'p2', title: '另一个项目' });
    const source: Source = {
      id: 's1', projectId: 'p1', kind: 'archive', title: '民政局救济档案', authors: ['市民政局'],
      year: 1935, venue: '市档案馆', identifier: 'A-1935-7', identifierType: 'other',
      filePath: 'D:\\archive\\relief.pdf', externalUrl: null, tags: ['救济', '档案'], metadata: {},
      sourceVersionHash: 'hash-1', provenance: { origin: 'user' }, createdAt: 2, updatedAt: 2, deletedAt: null,
    };
    repository.saveSource(source);
    repository.saveSource({ ...source, id: 's2', projectId: 'p2', title: '不应泄露的资料' });
    const evidence: Evidence = {
      id: 'e1', projectId: 'p1', sourceId: 's1', anchorType: 'page', anchorStart: null, anchorEnd: null,
      pageNumber: 12, snippet: '1935 年救济对象开始按职业分类。', snippetHash: 'snippet-1',
      sourceVersionHash: 'hash-1', confidence: 0.9, metadata: {}, createdAt: 3, updatedAt: 3, deletedAt: null,
    };
    repository.saveEvidence(evidence);
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dataDir, { recursive: true, force: true });
  });

  it('returns only canonical sources and anchored evidence from the active project', async () => {
    const handler = createProjectResearchToolHandlers(repository).get('list_sources');
    const output = await handler?.({ query: '职业', limit: 10 }, {
      sessionId: 'auto-1', workspace: '.', turnIndex: 0, projectId: 'p1',
    });
    const result = JSON.parse(output ?? '{}') as Record<string, unknown>;

    expect(result).toMatchObject({ returned: 1, totalProjectSources: 1 });
    expect(output).toContain('民政局救济档案');
    expect(output).toContain('1935 年救济对象开始按职业分类');
    expect(output).toContain('D:\\\\archive\\\\relief.pdf');
    expect(output).not.toContain('不应泄露的资料');
  });

  it('rejects calls without an active project scope', async () => {
    const handler = createProjectResearchToolHandlers(repository).get('list_sources');
    await expect(handler?.({}, { sessionId: 'auto-1', workspace: '.', turnIndex: 0 }))
      .rejects.toThrow('requires an active research project');
  });
});
