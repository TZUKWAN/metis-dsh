import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';

describe('OutcomeRepository.locateSource (OUT-11)', () => {
  let db: Database.Database;
  let repository: OutcomeRepository;
  let outcomeId: string;

  beforeEach(() => {
    db = new Database(':memory:');
    db.exec(SCHEMA_SQL);
    const insProj = db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)');
    insProj.run('project-a', '项目A', '', '', 'active', '', '', '{}', 1, 1, 1, 'user');
    insProj.run('project-b', '项目B', '', '', 'active', '', '', '{}', 1, 1, 1, 'user');
    db.prepare('INSERT INTO research_artifacts (id,project_id,title,artifact_type,review_status,content_ref,input_hash,provenance,metadata,version,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
      .run('artifact-a', 'project-a', '项目A资料', 'report', 'draft', null, null, '{}', '{}', 1, 1, 11);
    db.prepare('INSERT INTO research_artifacts (id,project_id,title,artifact_type,review_status,content_ref,input_hash,provenance,metadata,version,created_at,updated_at,deleted_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,NULL)')
      .run('artifact-b', 'project-b', '项目B资料', 'report', 'draft', null, null, '{}', '{}', 1, 1, 12);
    repository = new OutcomeRepository(db);
    outcomeId = repository.create({
      projectId: 'project-a', categoryId: null, title: '成果A', kind: 'word', note: '',
      content: { type: 'word', blocks: [{ id: 'p', kind: 'paragraph', text: 'x' }], page: {}, header: '', footer: '' },
    }).outcome.id;
  });

  afterEach(() => { if (db) db.close(); });

  it('locates an artifact owned by the requested project', () => {
    const result = repository.locateSource({ projectId: 'project-a', source: { kind: 'artifact', id: 'artifact-a', label: 'x' } });
    expect(result).toEqual({ ok: true, kind: 'artifact', targetId: 'artifact-a', label: expect.stringContaining('项目A资料') });
  });

  it('refuses a foreign artifact (cross-project isolation)', () => {
    const result = repository.locateSource({ projectId: 'project-a', source: { kind: 'artifact', id: 'artifact-b', label: 'x' } });
    expect(result).toEqual({ ok: false, code: 'source_not_found' });
  });

  it('locates an outcome_version owned by the project', () => {
    const result = repository.locateSource({ projectId: 'project-a', source: { kind: 'outcome_version', id: outcomeId, version: 1, label: 'x' } });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.kind).toBe('outcome_version'); expect(result.targetId).toBe(outcomeId); }
  });

  it('locates project_metis when the project exists', () => {
    const result = repository.locateSource({ projectId: 'project-a', source: { kind: 'project_metis', id: 'project-a', label: 'x' } });
    expect(result.ok).toBe(true);
    if (result.ok) { expect(result.kind).toBe('project_metis'); expect(result.targetId).toBe('project-a'); }
  });

  it('returns source_not_locatable for kinds with no locatable backend', () => {
    for (const kind of ['upload', 'source', 'evidence', 'note_code', 'claim', 'selection'] as const) {
      const result = repository.locateSource({ projectId: 'project-a', source: { kind, id: 'some-id', label: 'x' } });
      expect(result).toEqual({ ok: false, code: 'source_not_locatable' });
    }
  });

  it('returns source_not_found for a missing outcome_version id', () => {
    const result = repository.locateSource({ projectId: 'project-a', source: { kind: 'outcome_version', id: 'out-missing', label: 'x' } });
    expect(result).toEqual({ ok: false, code: 'source_not_found' });
  });
});
