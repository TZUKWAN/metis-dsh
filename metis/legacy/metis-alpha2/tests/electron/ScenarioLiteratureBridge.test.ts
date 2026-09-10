/**
 * ScenarioLiteratureBridge 单测（2026-08-30 刘总问题 B 修复）
 * 覆盖：结构闸（JSON 题录提取）、真实性闸三态+网络降级、三写入库、幂等重放、
 * 已存在论文不被覆盖。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import {
  createScenarioLiteratureBridge,
  extractBibliographyEntries,
} from '../../electron/ScenarioLiteratureBridge.js';

let dir: string;
let store: PersistenceStore;
let repo: ResearchRepository;

const VERIFIED_DOI = '10.1145/276675.276685';

function seedProject(): void {
  repo.createProject({
    id: 'project-1',
    title: 'Bridge Project',
    originalIntent: '',
    researchQuestion: '',
    lifecycle: 'active',
    methodology: '',
    discipline: '',
    metadata: {},
    createdAt: 1000,
    updatedAt: 1000,
    archivedAt: null,
    version: 1,
    source: 'user',
    deletedAt: null,
  } as never);
}

function bibliographyBlock(entries: unknown[]): string {
  return `# 检索结果\n\n以下是检索到的文献：\n\n\`\`\`json\n${JSON.stringify(entries, null, 2)}\n\`\`\`\n`;
}

const ENTRY_WITH_DOI = {
  title: 'The Anatomy of a Large-Scale Search Engine',
  authors: ['Sergey Brin', 'Lawrence Page'],
  year: 1998,
  venue: 'Computer Networks and ISDN Systems',
  doi: `https://doi.org/${VERIFIED_DOI}`,
};

beforeEach(() => {
  dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-literature-bridge-'));
  store = new PersistenceStore(path.join(dir, 'test.db'));
  repo = new ResearchRepository(store.raw);
  seedProject();
});

afterEach(() => {
  store.close();
  fs.rmSync(dir, { recursive: true, force: true });
});

describe('extractBibliographyEntries（结构闸）', () => {
  it('parses a fenced json array and normalizes fields', () => {
    const entries = extractBibliographyEntries(bibliographyBlock([
      ENTRY_WITH_DOI,
      { title: 'Second Work', authors: 'Alice Zhang, Bob Li and Carol Wang', year: '2021', journal: 'Nature', url: 'https://example.com/paper' },
    ]));
    expect(entries).toHaveLength(2);
    expect(entries[0]).toMatchObject({
      title: ENTRY_WITH_DOI.title,
      authors: ['Sergey Brin', 'Lawrence Page'],
      year: 1998,
      venue: 'Computer Networks and ISDN Systems',
      doi: VERIFIED_DOI, // doi.org 前缀归一化剥除
    });
    expect(entries[1]?.authors).toEqual(['Alice Zhang', 'Bob Li', 'Carol Wang']);
    expect(entries[1]?.year).toBe(2021);
    expect(entries[1]?.venue).toBe('Nature');
  });

  it('parses a wrapped object ({references:[...]}) and bare arrays without fences', () => {
    const wrapped = extractBibliographyEntries(`结果如下：{"references": [${JSON.stringify(ENTRY_WITH_DOI)}]}`);
    expect(wrapped).toHaveLength(1);
    const bare = extractBibliographyEntries(`no fence here\n[${JSON.stringify(ENTRY_WITH_DOI)}]\ntrail`);
    expect(bare).toHaveLength(1);
  });

  it('returns nothing for free-text markdown and drops title-less objects', () => {
    expect(extractBibliographyEntries('# 正文\n\n没有任何结构化题录。')).toEqual([]);
    expect(extractBibliographyEntries(bibliographyBlock([{ authors: ['Nobody'], year: 2020 }]))).toEqual([]);
  });

  it('deduplicates repeated entries by doi', () => {
    const entries = extractBibliographyEntries(bibliographyBlock([ENTRY_WITH_DOI, ENTRY_WITH_DOI]));
    expect(entries).toHaveLength(1);
  });
});

describe('createScenarioLiteratureBridge（真实性闸 + 三写）', () => {
  it('accepts DOI-verified entries, rejects crossref-404 DOIs, and three-table-writes the accepted ones', async () => {
    const bridge = createScenarioLiteratureBridge({
      store,
      researchRepository: repo,
      verifyDoi: async (doi) => (doi === VERIFIED_DOI ? 'found' : 'not_found'),
      now: () => 1_700_000_000_000,
    });
    const result = await bridge({
      projectId: 'project-1',
      artifactId: 'artifact-1',
      runId: 'run-1',
      stepId: 'search-step',
      content: bibliographyBlock([
        ENTRY_WITH_DOI,
        { title: 'Fabricated Work With Fake Doi', authors: ['Ghost'], year: 2023, venue: 'Nowhere', doi: '10.9999/fake.1234' },
      ]),
    });
    expect(result).toMatchObject({
      parsed: 2,
      imported: 1,
      linked: 1,
      rejectedDoiNotFound: 1,
      rejectedUnverifiable: 0,
      unverifiedNetwork: 0,
    });
    // papers 表只收了真的那篇
    const papers = store.getPapers();
    expect(papers).toHaveLength(1);
    expect(papers[0]).toMatchObject({
      title: ENTRY_WITH_DOI.title,
      authors: ['Sergey Brin', 'Lawrence Page'],
      year: 1998,
      venue: 'Computer Networks and ISDN Systems',
      doi: VERIFIED_DOI,
      projectId: 'project-1',
      readStatus: 'unread',
    });
    // sources + paper_project_links 三写证据
    const sources = repo.listSources('project-1');
    expect(sources).toHaveLength(1);
    expect(sources[0]?.title).toBe(ENTRY_WITH_DOI.title);
    const linkCount = store.raw
      .prepare('SELECT COUNT(*) AS n FROM paper_project_links WHERE project_id = ?')
      .get('project-1') as { n: number };
    expect(linkCount.n).toBe(1);
  });

  it('accepts url-only entries directly, rejects entries with neither doi nor url, and counts network-unverified DOIs', async () => {
    const bridge = createScenarioLiteratureBridge({
      store,
      researchRepository: repo,
      verifyDoi: async () => 'unknown', // 模拟 crossref 网络故障
      now: () => 1_700_000_000_000,
    });
    const result = await bridge({
      projectId: 'project-1',
      artifactId: 'artifact-2',
      runId: 'run-2',
      content: bibliographyBlock([
        { title: 'Url Only Work', authors: ['A'], year: 2022, venue: 'Conf', url: 'https://example.com/x' },
        { title: 'Bare Citation From Memory', authors: ['B'], year: 2019, venue: 'Journal' },
        { title: 'Network Unverified Doi Work', authors: ['C'], year: 2024, venue: 'J', doi: '10.1000/xyz123' },
      ]),
    });
    expect(result).toMatchObject({
      parsed: 3,
      imported: 2,          // url 直收 + 网络未证实收编
      linked: 2,
      rejectedUnverifiable: 1, // 裸文本题录拒收
      unverifiedNetwork: 1,
    });
    const titles = store.getPapers().map((paper) => paper.title).sort();
    expect(titles).toEqual(['Network Unverified Doi Work', 'Url Only Work']);
  });

  it('is idempotent on replay and never overwrites an existing paper row', async () => {
    const bridge = createScenarioLiteratureBridge({
      store,
      researchRepository: repo,
      verifyDoi: async () => 'found',
      now: () => 1_700_000_000_000,
    });
    const input = {
      projectId: 'project-1',
      artifactId: 'artifact-3',
      runId: 'run-3',
      content: bibliographyBlock([ENTRY_WITH_DOI]),
    };
    const first = await bridge(input);
    expect(first).toMatchObject({ imported: 1, linked: 1 });

    // 用户随后给这篇论文写了笔记/打了分——重放不得覆盖。
    const paperId = store.getPapers()[0]!.id;
    store.savePaper({
      id: paperId,
      title: ENTRY_WITH_DOI.title,
      authors: ENTRY_WITH_DOI.authors,
      year: ENTRY_WITH_DOI.year,
      venue: ENTRY_WITH_DOI.venue,
      abstract: '',
      doi: VERIFIED_DOI,
      tags: ['important'],
      notes: '刘总的批注',
      readStatus: 'read',
      rating: 5,
      addedAt: 1_700_000_000_000,
      projectId: 'project-1',
    });

    const replay = await bridge({ ...input, runId: 'run-3-replay' });
    expect(replay).toMatchObject({ parsed: 1, imported: 0, linked: 1 });
    expect(store.getPapers()).toHaveLength(1);
    expect(store.getPapers()[0]).toMatchObject({ notes: '刘总的批注', rating: 5, readStatus: 'read' });
    expect(repo.listSources('project-1')).toHaveLength(1);
  });

  it('no-ops on non-bibliography artifacts', async () => {
    const bridge = createScenarioLiteratureBridge({
      store,
      researchRepository: repo,
      verifyDoi: async () => 'found',
    });
    const result = await bridge({
      projectId: 'project-1',
      artifactId: 'artifact-4',
      runId: 'run-4',
      content: '# 纯文本过程产出\n\n只有叙述，没有题录 JSON。',
    });
    expect(result.parsed).toBe(0);
    expect(store.getPapers()).toEqual([]);
    expect(repo.listSources('project-1')).toEqual([]);
  });
});
