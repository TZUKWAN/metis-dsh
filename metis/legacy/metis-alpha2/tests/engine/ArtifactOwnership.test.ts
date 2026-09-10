/**
 * Artifact ownership (task 1 §五).
 *
 * Invariants under test:
 *  - Deleting a session/conversation removes its messages, transient runs and
 *    checkpoints — but NEVER the project-level artifacts it produced.
 *  - Artifacts of project-less sessions land in the system unassigned project.
 *  - Project-owned mirrors are created in the same transaction as the legacy write
 *    (dual-write) and carry provenance pointing back at the creating session.
 *  - Migration into the project store is idempotent (no duplicate mirrors/versions).
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { PersistenceStore, UNASSIGNED_ARTIFACT_PROJECT_ID } from '../../engine/persistence/PersistenceStore.js';

function tempDir(): string {
  return fs.mkdtempSync(path.join(os.tmpdir(), 'metis-artifact-owner-'));
}

describe('artifact ownership on session deletion', () => {
  let dir: string;
  let dbPath: string;
  let store: PersistenceStore;

  beforeEach(() => {
    dir = tempDir();
    dbPath = path.join(dir, 'metis.db');
    store = new PersistenceStore(dbPath);
    store.raw.prepare(`
      INSERT INTO projects (id, title, created_at, updated_at) VALUES ('proj-a', '项目A', 1, 1)
    `).run();
  });

  afterEach(() => {
    store.close();
    fs.rmSync(dir, { recursive: true, force: true });
  });

  function mirrorCount(id: string): number {
    return (store.raw.prepare('SELECT COUNT(*) c FROM research_artifacts WHERE id = ?').get(`ra-${id}`) as { c: number }).c;
  }

  it('dual-writes a project-owned mirror when the session belongs to a project', () => {
    store.createSession('s1', {}, 'proj-a');
    store.createArtifacts([{
      id: 'art-1', sessionId: 's1', name: '图表A', type: 'chart', content: 'chart-data',
    }]);

    expect(mirrorCount('art-1')).toBe(1);
    const mirror = store.raw.prepare('SELECT * FROM research_artifacts WHERE id = ?').get('ra-art-1') as Record<string, unknown>;
    expect(mirror.project_id).toBe('proj-a');
    expect(mirror.title).toBe('图表A');
    const provenance = JSON.parse(mirror.provenance as string);
    expect(provenance.createdBySessionId).toBe('s1');
    expect(provenance.sourceArtifactId).toBe('art-1');
    const version = store.raw.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ?').get('ra-art-1') as Record<string, unknown>;
    expect(version.version).toBe(1);
    expect(version.content).toBe('chart-data');
  });

  it('deleting a project session keeps the artifact (project asset) and drops the conversation data', () => {
    store.createSession('s1', {}, 'proj-a');
    store.createArtifacts([{ id: 'art-1', sessionId: 's1', name: '报告', type: 'report', content: 'final-report' }]);
    store.appendMessage('s1', 'user', '你好');

    store.deleteSession('s1');

    // Conversation data is gone.
    expect((store.raw.prepare('SELECT COUNT(*) c FROM messages WHERE session_id = ?').get('s1') as { c: number }).c).toBe(0);
    expect(store.getSession('s1')).toBeUndefined();
    // The legacy session-owned row is gone (cascade) — and the project asset survives.
    expect((store.raw.prepare('SELECT COUNT(*) c FROM artifacts WHERE id = ?').get('art-1') as { c: number }).c).toBe(0);
    const mirror = store.raw.prepare('SELECT * FROM research_artifacts WHERE id = ?').get('ra-art-1') as Record<string, unknown>;
    expect(mirror).toBeDefined();
    expect(mirror.project_id).toBe('proj-a');
    expect(mirror.deleted_at).toBeNull();
    const version = store.raw.prepare('SELECT * FROM artifact_versions WHERE artifact_id = ?').get('ra-art-1') as Record<string, unknown>;
    expect(version.content).toBe('final-report');
    const provenance = JSON.parse(mirror.provenance as string);
    expect(provenance.createdBySessionId).toBe('s1'); // provenance keeps the origin; owner stays the project
    // The mirror was created by the dual-write (not migrated at deletion time).
    expect(provenance.migratedFrom).toBeUndefined();
  });

  it('migrates artifacts of a project-less session into the system unassigned project', () => {
    store.createSession('s-free'); // no project
    store.createArtifacts([{ id: 'art-free', sessionId: 's-free', name: '自由成果', type: 'other', content: 'x' }]);
    // No mirror while the session lives project-less.
    expect(mirrorCount('art-free')).toBe(0);

    store.deleteSession('s-free');

    const mirror = store.raw.prepare('SELECT * FROM research_artifacts WHERE id = ?').get('ra-art-free') as Record<string, unknown>;
    expect(mirror).toBeDefined();
    expect(mirror.project_id).toBe(UNASSIGNED_ARTIFACT_PROJECT_ID);
    const project = store.raw.prepare('SELECT * FROM projects WHERE id = ?').get(UNASSIGNED_ARTIFACT_PROJECT_ID) as Record<string, unknown>;
    expect(project).toBeDefined();
    expect(project.source).toBe('system');
  });

  it('migrates pre-dual-write artifacts (old databases) on session deletion, without duplicating versions', () => {
    store.createSession('s-old', {}, 'proj-a');
    // Plant a pre-mirror era row exactly as old code wrote it.
    store.raw.prepare(`
      INSERT INTO artifacts (id, session_id, name, type, path, size, content, metadata, created_at)
      VALUES ('art-old', 's-old', '旧图表', 'chart', NULL, NULL, 'old-data', '{}', 12345)
    `).run();

    store.deleteSession('s-old');

    expect(mirrorCount('art-old')).toBe(1);
    const versions = store.raw.prepare('SELECT COUNT(*) c FROM artifact_versions WHERE artifact_id = ?').get('ra-art-old') as { c: number };
    expect(versions.c).toBe(1);
    const mirror = store.raw.prepare('SELECT * FROM research_artifacts WHERE id = ?').get('ra-art-old') as Record<string, unknown>;
    expect(mirror.project_id).toBe('proj-a');
    expect(mirror.created_at).toBe(12345); // timeline preserved
  });

  it('is idempotent: mirroring an identical replay creates exactly one mirror and one version', () => {
    store.createSession('s1', {}, 'proj-a');
    const record = { id: 'art-idem', sessionId: 's1', name: 'N', type: 'table', content: 'c' };
    store.createArtifacts([record]);
    store.createArtifacts([record]); // identical replay is allowed and must be a no-op
    expect(mirrorCount('art-idem')).toBe(1);
    const versions = store.raw.prepare('SELECT COUNT(*) c FROM artifact_versions WHERE artifact_id = ?').get('ra-art-idem') as { c: number };
    expect(versions.c).toBe(1);
  });

  it('deleteArtifact removes the mirror too (explicit user deletion), soft-deleting the project asset', () => {
    store.createSession('s1', {}, 'proj-a');
    store.createArtifacts([{ id: 'art-del', sessionId: 's1', name: 'X', type: 'other', content: 'x' }]);
    store.deleteArtifact('art-del');
    expect((store.raw.prepare('SELECT COUNT(*) c FROM artifacts WHERE id = ?').get('art-del') as { c: number }).c).toBe(0);
    const mirror = store.raw.prepare('SELECT * FROM research_artifacts WHERE id = ?').get('ra-art-del') as Record<string, unknown>;
    expect(mirror.deleted_at).not.toBeNull();
    // Version history rows are retained.
    const versions = store.raw.prepare('SELECT COUNT(*) c FROM artifact_versions WHERE artifact_id = ?').get('ra-art-del') as { c: number };
    expect(versions.c).toBe(1);
  });
});
