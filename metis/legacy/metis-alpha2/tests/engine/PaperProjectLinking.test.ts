import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import Database from 'better-sqlite3';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import type { Project } from '../../engine/persistence/researchModel.js';

function project(id: string): Project {
  const now = Date.now();
  return {
    id,
    title: id,
    originalIntent: '',
    researchQuestion: '',
    lifecycle: 'draft',
    methodology: '',
    discipline: '',
    metadata: {},
    createdAt: now,
    updatedAt: now,
    archivedAt: null,
    version: 1,
    source: 'user',
    deletedAt: null,
  };
}

describe('library paper project linking', () => {
  let dir: string;
  let store: PersistenceStore;
  let repository: ResearchRepository;

  beforeEach(() => {
    dir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-paper-project-'));
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    repository = new ResearchRepository(store.raw);
    repository.createProject(project('project-a'));
    repository.createProject(project('project-b'));
    store.savePaper({
      id: 'paper-1',
      title: 'Shared paper',
      authors: ['Researcher'],
      year: 2025,
      venue: 'Journal',
      abstract: 'Initial abstract',
      doi: '10.1000/shared',
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: 1,
    });
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('links one library paper to multiple projects using distinct project-local sources', () => {
    const first = repository.linkLibraryPaperToProject({
      paperId: 'paper-1',
      projectId: 'project-a',
      title: 'Shared paper',
      authors: ['Researcher'],
      year: 2025,
      venue: 'Journal',
      doi: '10.1000/shared',
    });
    const second = repository.linkLibraryPaperToProject({
      paperId: 'paper-1',
      projectId: 'project-b',
      title: 'Shared paper',
      authors: ['Researcher'],
      year: 2025,
      venue: 'Journal',
      doi: '10.1000/shared',
    });

    expect(first?.id).not.toBe(second?.id);
    expect(repository.listSources('project-a')).toHaveLength(1);
    expect(repository.listSources('project-b')).toHaveLength(1);
    expect(repository.listSources('project-a')[0]?.libraryPaperId).toBe('paper-1');
    expect(repository.listSources('project-b')[0]?.libraryPaperId).toBe('paper-1');

    const paper = store.getPapers().find((item) => item.id === 'paper-1');
    expect(paper?.projectIds).toEqual(['project-a', 'project-b']);
    expect(paper?.projectId).toBe('project-a');
  });

  it('preserves every project link during an ordinary paper save', () => {
    for (const projectId of ['project-a', 'project-b']) {
      repository.linkLibraryPaperToProject({
        paperId: 'paper-1',
        projectId,
        title: 'Shared paper',
        authors: ['Researcher'],
        year: 2025,
        venue: 'Journal',
        doi: '10.1000/shared',
      });
    }

    store.savePaper({
      id: 'paper-1',
      title: 'Shared paper revised',
      authors: ['Researcher'],
      year: 2025,
      venue: 'Journal',
      abstract: 'Updated abstract',
      doi: '10.1000/shared',
      tags: ['reviewed'],
      notes: 'A note',
      readStatus: 'read',
      rating: 5,
      addedAt: 1,
    });

    const paper = store.getPapers().find((item) => item.id === 'paper-1');
    expect(paper?.projectIds).toEqual(['project-a', 'project-b']);
    expect(paper?.projectId).toBe('project-a');
    expect(paper?.title).toBe('Shared paper revised');
  });

  it('unlinks only the selected project and retains its research source as soft-deleted', () => {
    const sources = ['project-a', 'project-b'].map((projectId) => repository.linkLibraryPaperToProject({
      paperId: 'paper-1',
      projectId,
      title: 'Shared paper',
      authors: ['Researcher'],
      year: 2025,
      venue: 'Journal',
      doi: '10.1000/shared',
    }));

    expect(repository.unlinkLibraryPaperFromProject('paper-1', 'project-a')).toBe(true);
    const paper = store.getPapers().find((item) => item.id === 'paper-1');
    expect(paper?.projectIds).toEqual(['project-b']);
    expect(paper?.projectId).toBe('project-b');
    expect(repository.listSources('project-a')).toEqual([]);
    expect(repository.getSource(sources[0]!.id, true)?.deletedAt).not.toBeNull();
    expect(repository.listSources('project-b').map((source) => source.id)).toEqual([sources[1]!.id]);
  });

  it('backfills legacy single-project links idempotently on restart', () => {
    store.raw.prepare('UPDATE papers SET project_id = ? WHERE id = ?').run('project-a', 'paper-1');
    store.raw.prepare(`
      INSERT INTO sources (
        id, project_id, kind, title, authors, identifier, identifier_type,
        created_at, updated_at
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run('paper-1', 'project-a', 'paper', 'Shared paper', '[]', '10.1000/shared', 'doi', 1, 1);
    store.close();

    // Simulate a genuinely pre-v105 database: the links table does not exist yet and
    // the migration ledger does not claim v105 ran. (Deleting only the link rows on an
    // already-migrated database must NOT resurrect them — versioned migrations run once.)
    const raw = new Database(path.join(dir, 'metis.db'));
    raw.exec(`
      DROP TABLE paper_project_links;
      DROP INDEX IF EXISTS idx_sources_project_library_paper;
      DELETE FROM schema_migrations WHERE version >= 105;
    `);
    raw.close();

    store = new PersistenceStore(path.join(dir, 'metis.db'));
    repository = new ResearchRepository(store.raw);

    expect(store.getPapers().find((item) => item.id === 'paper-1')?.projectIds).toEqual(['project-a']);
    expect(repository.getSource('paper-1')?.libraryPaperId).toBe('paper-1');

    store.close();
    store = new PersistenceStore(path.join(dir, 'metis.db'));
    repository = new ResearchRepository(store.raw);
    expect(store.getPapers().find((item) => item.id === 'paper-1')?.projectIds).toEqual(['project-a']);
  });
});
