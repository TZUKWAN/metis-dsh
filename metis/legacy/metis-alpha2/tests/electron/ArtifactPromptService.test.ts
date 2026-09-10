import { describe, expect, it } from 'vitest';
import Database from 'better-sqlite3';
import { ArtifactPromptService } from '../../electron/ArtifactPromptService.js';
import { ARTIFACT_PROMPT_DEFINITIONS } from '../../engine/artifacts/prompts/ArtifactPromptRegistry.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';

function createService(): ArtifactPromptService {
  const db = new Database(':memory:');
  db.exec(SCHEMA_SQL);
  return new ArtifactPromptService(db);
}

describe('Artifact Prompt Registry(2026-09-05 任务4:成果提示词工程)', () => {
  it('registry entries are complete and have stable ids', () => {
    expect(ARTIFACT_PROMPT_DEFINITIONS.length).toBeGreaterThanOrEqual(4);
    const ids = ARTIFACT_PROMPT_DEFINITIONS.map((definition) => definition.id);
    expect(new Set(ids).size).toBe(ids.length);
    for (const definition of ARTIFACT_PROMPT_DEFINITIONS) {
      expect(definition.defaultPrompt).toBeDefined();
      expect(definition.scopeNote.length).toBeGreaterThan(8);
      expect(definition.editable).toBe(true);
    }
  });

  it('defaults are used without override; status is default', () => {
    const service = createService();
    const view = service.getView('outcome.assistant')!;
    expect(view.status).toBe('default');
    expect(view.effectiveContent).toBe(view.definition.defaultPrompt);
    expect(service.resolve('outcome.assistant')).toBe(view.definition.defaultPrompt);
  });

  it('saveOverride stores content+revision and resolver returns user content', () => {
    const service = createService();
    const custom = '自定义行为:重写时优先保持原有论证结构。';
    const result = service.saveOverride({ promptId: 'outcome.assistant', content: custom });
    expect(result.ok).toBe(true);
    const view = service.getView('outcome.assistant')!;
    expect(view.status).toBe('customized');
    expect(view.override?.content).toBe(custom);
    expect(service.resolve('outcome.assistant')).toBe(custom);
    const revisions = service.listRevisions('outcome.assistant');
    expect(revisions).toHaveLength(1);
    expect(revisions[0]?.source).toBe('manual');
  });

  it('saving factory-equal content resets instead of storing a no-op override', () => {
    const service = createService();
    const definition = ARTIFACT_PROMPT_DEFINITIONS.find((item) => item.id === 'presentation.generation')!;
    const result = service.saveOverride({ promptId: definition.id, content: definition.defaultPrompt });
    expect(result.ok).toBe(true);
    expect(service.getOverride(definition.id)).toBeNull();
    expect(service.getView(definition.id)!.status).toBe('default');
  });

  it('disable falls back to default while keeping user content; reset deletes override but keeps revisions', () => {
    const service = createService();
    service.saveOverride({ promptId: 'outcome.assistant', content: '用户自定义内容版本一。' });
    const disabled = service.setEnabled('outcome.assistant', false);
    expect(disabled.ok).toBe(true);
    expect(service.getView('outcome.assistant')!.status).toBe('disabled');
    expect(service.resolve('outcome.assistant')).toBe(service.getView('outcome.assistant')!.definition.defaultPrompt);
    expect(service.getView('outcome.assistant')!.override?.content).toBe('用户自定义内容版本一。');

    const reset = service.resetOverride('outcome.assistant');
    expect(reset.ok).toBe(true);
    expect(service.getOverride('outcome.assistant')).toBeNull();
    expect(service.listRevisions('outcome.assistant').length).toBe(1);
  });

  it('restoreRevision creates a new revision without deleting later history', () => {
    const service = createService();
    service.saveOverride({ promptId: 'document.cover_letter', content: '版本一。' });
    service.saveOverride({ promptId: 'document.cover_letter', content: '版本二。' });
    const first = service.listRevisions('document.cover_letter').find((revision) => revision.content === '版本一。')!;
    const restore = service.restoreRevision('document.cover_letter', first.id);
    expect(restore.ok).toBe(true);
    const revisions = service.listRevisions('document.cover_letter');
    expect(revisions).toHaveLength(3);
    expect(service.resolve('document.cover_letter')).toBe('版本一。');
  });

  it('unknown prompt ids are rejected (no fake configuration)', () => {
    const service = createService();
    expect(service.saveOverride({ promptId: 'ppt.title_generation', content: 'x' }).ok).toBe(false);
    expect(service.resetOverride('nonexistent.prompt').ok).toBe(false);
    expect(service.resolve('nonexistent.prompt')).toBeNull();
  });

  it('image.generation default is empty (no behavior change before customization)', () => {
    const service = createService();
    expect(service.resolve('image.generation')).toBe('');
  });

  it('export/import round-trips overrides and reports unknown ids', () => {
    const service = createService();
    service.saveOverride({ promptId: 'outcome.assistant', content: '导出测试内容。' });
    service.saveOverride({ promptId: 'presentation.generation', content: 'PPT 导出内容。', enabled: false });
    const pack = service.exportPack();
    expect(pack.prompts).toHaveLength(2);

    const fresh = createService();
    const imported = fresh.importPack(pack);
    expect(imported.ok).toBe(true);
    if (!imported.ok) return;
    expect(imported.applied.sort()).toEqual(['outcome.assistant', 'presentation.generation']);
    expect(fresh.resolve('outcome.assistant')).toBe('导出测试内容。');
    expect(fresh.getView('presentation.generation')!.status).toBe('disabled');

    const bad = fresh.importPack({ schemaVersion: 1, prompts: [{ promptId: 'unknown.thing', content: 'x', baseVersion: 1, enabled: true }] });
    expect(bad.ok).toBe(true);
    if (bad.ok) expect(bad.unknownIds).toEqual(['unknown.thing']);
  });
});
