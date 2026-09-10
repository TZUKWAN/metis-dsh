import { afterEach, describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { LibraryNoteSchema } from '../../engine/runtime/LibraryRuntimeContract.js';

const roots: string[] = [];

afterEach(() => {
  for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true });
});

function dbPath(): string {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-note-scope-'));
  roots.push(root);
  return path.join(root, 'metis.db');
}

describe('global notes and project research memos', () => {
  it('persists their scope separately', () => {
    const store = new PersistenceStore(dbPath());
    store.saveNote({
      id: 'global-note', title: '全局便笺', content: '', tags: [],
      linkedPaperIds: [], linkedNoteIds: [], scope: 'global', updatedAt: 1,
    });
    store.saveNote({
      id: 'research-note', title: '项目研究备忘录', content: '资料判断', tags: [],
      linkedPaperIds: [], linkedNoteIds: [], scope: 'research', projectId: 'project-1', updatedAt: 2,
    });

    expect(store.getNotes()).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: 'global-note', scope: 'global', projectId: undefined }),
      expect.objectContaining({ id: 'research-note', scope: 'research', projectId: 'project-1' }),
    ]));
    store.close();
  });

  it('migrates legacy notes as global notes without assigning them to an arbitrary project', () => {
    const file = dbPath();
    const legacy = new Database(file);
    legacy.exec(`
      CREATE TABLE notes (
        id TEXT PRIMARY KEY, title TEXT NOT NULL, content TEXT NOT NULL DEFAULT '',
        tags TEXT NOT NULL DEFAULT '[]', linked_paper_ids TEXT NOT NULL DEFAULT '[]',
        linked_note_ids TEXT NOT NULL DEFAULT '[]', updated_at INTEGER NOT NULL
      );
      INSERT INTO notes VALUES ('legacy-note', '旧笔记', '', '[]', '[]', '[]', 1);
    `);
    legacy.close();

    const store = new PersistenceStore(file);
    expect(store.getNotes()).toContainEqual(expect.objectContaining({
      id: 'legacy-note',
      scope: 'global',
      projectId: undefined,
    }));
    store.close();
  });

  it('validates project-scoped research notes at the IPC contract boundary', () => {
    expect(LibraryNoteSchema.parse({
      id: 'research-note', title: '研究备忘录', content: '', tags: [],
      linkedPaperIds: [], linkedNoteIds: [], scope: 'research', projectId: 'project-1', updatedAt: 1,
    })).toMatchObject({ scope: 'research', projectId: 'project-1' });
    expect(LibraryNoteSchema.safeParse({
      id: 'bad-note', title: '坏数据', content: '', tags: [],
      linkedPaperIds: [], linkedNoteIds: [], scope: 'research', updatedAt: 1,
    }).success).toBe(false);
  });
});
