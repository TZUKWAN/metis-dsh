import Database from 'better-sqlite3';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { OutcomeRepository } from '../../electron/OutcomeRepository.js';

describe('OutcomeRepository', () => {
  let db: Database.Database;
  let repo: OutcomeRepository;
  beforeEach(() => {
    db = new Database(':memory:'); db.exec(SCHEMA_SQL);
    db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('project-a','Project A','','','active','','','{}',1,1,1,'user');
    db.prepare('INSERT INTO projects (id,title,original_intent,research_question,lifecycle,methodology,discipline,metadata,created_at,updated_at,version,source) VALUES (?,?,?,?,?,?,?,?,?,?,?,?)')
      .run('project-b','Project B','','','active','','','{}',1,1,1,'user');
    repo = new OutcomeRepository(db);
  });
  afterEach(() => db.close());
  const word = (text: string) => ({ type: 'word' as const, blocks: [{ id: 'p-1', kind: 'paragraph' as const, text }], page: {}, header: '', footer: '' });

  it('creates project-owned outcomes with immutable version one', () => {
    const category = repo.createCategory('中共党史');
    const created = repo.create({ projectId: 'project-a', categoryId: category.id, title: '论文', kind: 'word', content: word('draft'), note: 'initial' });
    expect(created.outcome).toMatchObject({ projectId: 'project-a', title: '论文', currentVersion: 1, categoryId: category.id });
    expect(created.version).toMatchObject({ version: 1, note: 'initial', createdBy: 'human' });
    expect(repo.list('project-a')).toHaveLength(1);
    expect(repo.list('project-b')).toHaveLength(0);
  });

  it('records an imported DOCX as an import-owned immutable first version', () => {
    const created = repo.create({ projectId: 'project-a', categoryId: null, title: '外部报告', kind: 'word', content: word('导入正文'), note: '导入 external.docx', actor: 'import' });
    expect(created.version).toMatchObject({ version: 1, createdBy: 'import', note: '导入 external.docx' });
    const change = db.prepare('SELECT actor, operation, summary FROM outcome_changes WHERE outcome_id = ?').get(created.outcome.id) as { actor: string; operation: string; summary: string };
    expect(change).toEqual({ actor: 'import', operation: 'import', summary: '导入 external.docx' });
  });

  it('renames categories and unlinks rather than deletes their outcomes', () => {
    const category = repo.createCategory('初稿');
    const created = repo.create({ projectId: 'project-a', categoryId: category.id, title: '项目报告', kind: 'word', content: word('body'), note: '' });
    expect(repo.renameCategory(category.id, '已完成')).toMatchObject({ id: category.id, name: '已完成' });
    expect(repo.deleteCategory(category.id)).toBe(true);
    expect(repo.get('project-a', created.outcome.id)?.outcome.categoryId).toBeNull();
    expect(repo.get('project-b', created.outcome.id)).toBeUndefined();
  });

  it('renames outcomes only within their owning project', () => {
    const created = repo.create({ projectId: 'project-a', categoryId: null, title: '旧标题', kind: 'word', content: word('body'), note: '' });
    expect(repo.rename('project-b', created.outcome.id, '越权标题')).toBeUndefined();
    expect(repo.rename('project-a', created.outcome.id, '新标题')).toMatchObject({ id: created.outcome.id, title: '新标题' });
    expect(repo.get('project-a', created.outcome.id)?.outcome.title).toBe('新标题');
  });

  it('uses optimistic version concurrency and never overwrites a newer edit', () => {
    const created = repo.create({ projectId: 'project-a', categoryId: null, title: '报告', kind: 'word', content: word('v1'), note: '' });
    const saved = repo.save({ projectId: 'project-a', outcomeId: created.outcome.id, baseVersion: 1, content: word('v2'), note: 'human edit', actor: 'human', sources: [] });
    expect(saved.outcome.currentVersion).toBe(2);
    expect(() => repo.save({ projectId: 'project-a', outcomeId: created.outcome.id, baseVersion: 1, content: word('stale'), note: '', actor: 'ai', sources: [] })).toThrow('outcome_version_conflict');
    expect(repo.get('project-a', created.outcome.id)?.version.content).toEqual(word('v2'));
    expect(repo.get('project-a', created.outcome.id, 1)?.version.content).toEqual(word('v1'));
  });

  it('restores by adding a new immutable version and can mark a final version', () => {
    const created = repo.create({ projectId: 'project-a', categoryId: null, title: '汇报', kind: 'ppt', content: { type: 'ppt', ratio: '16:9', theme: {}, templateId: null, pages: [] }, note: '' });
    repo.save({ projectId: 'project-a', outcomeId: created.outcome.id, baseVersion: 1, content: { type: 'ppt', ratio: '16:9', theme: {}, templateId: null, pages: [{ id: 'slide-1', title: 'A', pageType: 'content', humanModified: true, status: 'complete', elements: [] }] }, note: 'v2', actor: 'human', sources: [] });
    const restored = repo.restore('project-a', created.outcome.id, 1, 'back to v1');
    expect(restored.outcome.currentVersion).toBe(3);
    expect(restored.version.parentVersion).toBe(2);
    expect(restored.version.content).toEqual(created.version.content);
    const final = repo.markFinal('project-a', created.outcome.id, 3);
    expect(final).toMatchObject({ status: 'final', finalVersion: 3 });
  });

  it('enforces project isolation for reads, moves, versions and scoped conversations', () => {
    const created = repo.create({ projectId: 'project-a', categoryId: null, title: '隔离论文', kind: 'word', content: word('a'), note: '' });
    expect(repo.get('project-b', created.outcome.id)).toBeUndefined();
    expect(repo.versions('project-b', created.outcome.id)).toEqual([]);
    expect(repo.move('project-b', created.outcome.id, null)).toBeUndefined();
    expect(() => repo.appendConversation({ projectId: 'project-b', scope: 'outcome', outcomeId: created.outcome.id, scenarioId: null, role: 'user', content: 'cross project', sources: [] })).toThrow('outcome_not_found');
  });

  it('persists and restores outcome and scenario conversation history by project scope', () => {
    repo.appendConversation({ projectId: 'project-a', scope: 'scenario', outcomeId: null, scenarioId: 'scenario-1', role: 'user', content: 'plan', sources: [] });
    repo.appendConversation({ projectId: 'project-a', scope: 'scenario', outcomeId: null, scenarioId: 'scenario-1', role: 'assistant', content: 'answer', sources: [{ kind: 'artifact', id: 'artifact-1', label: '实验结果' }] });
    const messages = repo.listConversation({ projectId: 'project-a', scope: 'scenario', outcomeId: null, scenarioId: 'scenario-1' });
    expect(messages.map((item) => item.content)).toEqual(['plan','answer']);
    expect(messages[1]?.sources).toEqual([{ kind: 'artifact', id: 'artifact-1', label: '实验结果' }]);
  });

  // ── 回收站：软删除 → 7 天保留 → 惰性彻底删除（2026-08-24）──
  it('archives an outcome into the trash and restores it with every version intact', () => {
    const created = repo.create({ projectId: 'project-a', categoryId: null, title: '待删论文', kind: 'word', content: word('v1'), note: '' });
    repo.save({ projectId: 'project-a', outcomeId: created.outcome.id, baseVersion: 1, content: word('v2'), note: 'edit', actor: 'human', sources: [] });
    const before = Date.now();
    expect(repo.archive('project-a', created.outcome.id)).toBe(true);
    expect(repo.archive('project-a', created.outcome.id)).toBe(false);
    expect(repo.archive('project-b', created.outcome.id)).toBe(false);
    expect(repo.list('project-a')).toHaveLength(0);
    expect(repo.get('project-a', created.outcome.id)).toBeUndefined();
    const trash = repo.listArchived('project-a');
    expect(trash).toHaveLength(1);
    expect(trash[0]?.outcome.title).toBe('待删论文');
    expect(trash[0]?.deletedAt).toBeGreaterThanOrEqual(before);
    expect(trash[0]?.expiresAt).toBe(trash[0]!.deletedAt + 7 * 24 * 60 * 60 * 1000);
    expect(repo.restoreArchived('project-a', created.outcome.id)).toBe(true);
    expect(repo.listArchived('project-a')).toHaveLength(0);
    const restored = repo.get('project-a', created.outcome.id);
    expect(restored?.outcome.currentVersion).toBe(2);
    expect(restored?.version.content).toEqual(word('v2'));
  });

  it('permanently deletes only trashed outcomes with versions, changes, conversations and media rows', () => {
    const created = repo.create({ projectId: 'project-a', categoryId: null, title: '彻底删除', kind: 'image', content: { type: 'other', text: '', media: null }, note: '' });
    repo.appendConversation({ projectId: 'project-a', scope: 'outcome', outcomeId: created.outcome.id, scenarioId: null, role: 'user', content: 'hi', sources: [] });
    db.prepare('INSERT INTO outcome_media (id,project_id,outcome_id,media_type,display_name,stored_name,byte_length,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('om-1', 'project-a', created.outcome.id, 'image/png', 'cover.png', 'abc-deadbeef.png', 10, 'sha', 1);
    // 未进回收站的成果拒绝彻底删除，且不返回媒体清单
    expect(repo.deletePermanent('project-a', created.outcome.id)).toBeNull();
    expect(repo.get('project-a', created.outcome.id)).toBeDefined();
    repo.archive('project-a', created.outcome.id);
    expect(repo.deletePermanent('project-b', created.outcome.id)).toBeNull();
    const storedNames = repo.deletePermanent('project-a', created.outcome.id);
    expect(storedNames).toEqual(['abc-deadbeef.png']);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outcomes WHERE id = ?').get(created.outcome.id)).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM outcome_versions WHERE outcome_id = ?').get(created.outcome.id)).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM outcome_changes WHERE outcome_id = ?').get(created.outcome.id)).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM outcome_media WHERE outcome_id = ?').get(created.outcome.id)).toMatchObject({ n: 0 });
    expect(db.prepare('SELECT COUNT(*) AS n FROM scoped_conversations WHERE outcome_id = ?').get(created.outcome.id)).toMatchObject({ n: 0 });
    expect(repo.listArchived('project-a')).toHaveLength(0);
  });

  it('purgeExpired removes only outcomes past the seven-day retention and reports their media', () => {
    const fresh = repo.create({ projectId: 'project-a', categoryId: null, title: '刚删的', kind: 'word', content: word('a'), note: '' });
    const stale = repo.create({ projectId: 'project-a', categoryId: null, title: '过期的', kind: 'word', content: word('b'), note: '' });
    repo.archive('project-a', fresh.outcome.id);
    repo.archive('project-a', stale.outcome.id);
    db.prepare('INSERT INTO outcome_media (id,project_id,outcome_id,media_type,display_name,stored_name,byte_length,sha256,created_at) VALUES (?,?,?,?,?,?,?,?,?)')
      .run('om-2', 'project-a', stale.outcome.id, 'application/pdf', 'old.pdf', 'def-old.pdf', 10, 'sha', 1);
    const eightDaysAgo = Date.now() - 8 * 24 * 60 * 60 * 1000;
    db.prepare('UPDATE outcomes SET deleted_at = ? WHERE id = ?').run(eightDaysAgo, stale.outcome.id);
    const purged = repo.purgeExpired();
    expect(purged).toEqual([{ projectId: 'project-a', outcomeId: stale.outcome.id, storedNames: ['def-old.pdf'] }]);
    expect(repo.listArchived('project-a').map((entry) => entry.outcome.id)).toEqual([fresh.outcome.id]);
    expect(db.prepare('SELECT COUNT(*) AS n FROM outcomes WHERE id = ?').get(stale.outcome.id)).toMatchObject({ n: 0 });
    // 再次清理无副作用
    expect(repo.purgeExpired()).toEqual([]);
  });
});
