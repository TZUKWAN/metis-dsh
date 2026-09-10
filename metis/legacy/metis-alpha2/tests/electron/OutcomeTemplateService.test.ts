/**
 * OutcomeTemplateService — 统一成果模板持久化（Word 排版 / PPT 视觉）。
 *
 * 用临时 SQLite 库验证真实 CRUD：保存规范化、默认模板指针、
 * 删除时清理默认引用、损坏行 fail-closed、大小预算 fail-closed。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';
import { OutcomeTemplateService } from '../../electron/OutcomeTemplateService.js';

let tmpDir: string;
let store: PersistenceStore;
let service: OutcomeTemplateService;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-outcome-templates-'));
  store = new PersistenceStore(path.join(tmpDir, 'test.db'));
  service = new OutcomeTemplateService(store);
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

const wordDefinition = {
  config: {
    page: { paper: 'A4' as const, marginTopCm: 2.54, marginBottomCm: 2.54, marginLeftCm: 3.17, marginRightCm: 3.17 },
    body: { fontFamily: '宋体', fontSizePt: 12, align: 'justify' as const, firstLineIndentChars: 2, lineSpacing: 1.5, spaceBeforePt: 0, spaceAfterPt: 6 },
    headings: { 1: { fontFamily: '黑体', fontSizePt: 16, align: 'center' as const }, 2: {}, 3: {}, 4: {}, 5: {}, 6: {} },
    captions: { fontFamily: '宋体', fontSizePt: 10.5, align: 'center' as const },
  },
  header: '研究报告',
  footer: 'METIS',
  pageNumber: true,
};

describe('OutcomeTemplateService — 保存与规范化', () => {
  it('保存 Word 模板并持久化契约默认值', () => {
    const saved = service.save({ kind: 'word_formatting', name: '标准报告', definition: { config: { body: { fontSizePt: 12 } } } });
    expect(saved.name).toBe('标准报告');
    expect(saved.definition).toEqual({
      config: { body: { fontSizePt: 12 } },
      header: '',
      footer: '',
      pageNumber: false,
    });
    const rows = service.list('word_formatting');
    expect(rows).toHaveLength(1);
    expect(rows[0]!.id).toBe(saved.id);
  });

  it('拒绝非法 PPT definition 且不写入任何行', () => {
    expect(() => service.save({ kind: 'ppt', name: '坏比例', definition: { ratio: '21:9' } })).toThrow();
    expect(() => service.save({ kind: 'ppt', name: '空页面', definition: { ratio: '16:9', pages: [] } })).toThrow();
    expect(service.list('ppt')).toHaveLength(0);
  });

  it('保存 PPT 模板并原样读回 ratio/theme', () => {
    const saved = service.save({ kind: 'ppt', name: '学术蓝', definition: { ratio: '4:3', theme: { primary: '#236c91' } } });
    expect(saved.definition).toEqual({ ratio: '4:3', theme: { primary: '#236c91' } });
    expect(service.list('ppt')[0]!.definition).toEqual(saved.definition);
  });

  it('超出大小预算的模板 fail-closed，不写入行', () => {
    expect(() => service.save({ kind: 'ppt', name: '超大', definition: { theme: { junk: 'x'.repeat(1_100_000) } } })).toThrow();
    expect(service.list('ppt')).toHaveLength(0);
  });
});

describe('OutcomeTemplateService — 更新与删除', () => {
  it('分别更新名称与 definition，并要求至少一项变更', () => {
    const saved = service.save({ kind: 'word_formatting', name: '旧名', definition: wordDefinition });
    const renamed = service.update({ id: saved.id, kind: 'word_formatting', name: '新名' });
    expect(renamed.name).toBe('新名');
    expect(renamed.definition).toEqual(saved.definition);

    const updated = service.update({
      id: saved.id,
      kind: 'word_formatting',
      definition: { config: { body: { fontSizePt: 14 } }, header: 'H', footer: 'F', pageNumber: false },
    });
    expect(updated.name).toBe('新名');
    expect(updated.definition.config.body?.fontSizePt).toBe(14);

    expect(() => service.update({ id: saved.id, kind: 'word_formatting' } as never)).toThrow();
  });

  it('删除模板同时清理默认指针，删除缺失模板抛错', () => {
    const saved = service.save({ kind: 'ppt', name: '默认模板', definition: { ratio: '16:9' } });
    service.setDefault('ppt', saved.id);
    expect(service.getDefault('ppt')?.id).toBe(saved.id);

    service.delete({ id: saved.id, kind: 'ppt' });
    expect(service.list('ppt')).toHaveLength(0);
    expect(service.getDefault('ppt')).toBeNull();
    expect(() => service.delete({ id: saved.id, kind: 'ppt' })).toThrow('outcome_template_not_found');
  });

  it('损坏的 definition 行不出现在列表中，但仍可被删除', () => {
    store.raw.prepare(
      "INSERT INTO outcome_templates (id, name, kind, definition_json, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)",
    ).run('outcome-template-broken', '损坏模板', 'ppt', '{not json', Date.now(), Date.now());
    expect(service.list('ppt')).toHaveLength(0);
    service.delete({ id: 'outcome-template-broken', kind: 'ppt' });
    const remaining = store.raw.prepare('SELECT COUNT(*) AS n FROM outcome_templates').get() as { n: number };
    expect(remaining.n).toBe(0);
  });
});

describe('OutcomeTemplateService — 默认模板', () => {
  it('设置、读取并取消默认模板', () => {
    expect(service.getDefault('word_formatting')).toBeNull();
    const first = service.save({ kind: 'word_formatting', name: 'A', definition: wordDefinition });
    const second = service.save({ kind: 'word_formatting', name: 'B', definition: wordDefinition });

    expect(service.setDefault('word_formatting', first.id)?.id).toBe(first.id);
    expect(service.getDefault('word_formatting')?.id).toBe(first.id);
    expect(service.setDefault('word_formatting', second.id)?.id).toBe(second.id);
    expect(service.getDefault('word_formatting')?.id).toBe(second.id);

    service.setDefault('word_formatting', null);
    expect(service.getDefault('word_formatting')).toBeNull();
  });

  it('把不存在的模板设为默认会失败且不改变现有默认', () => {
    const saved = service.save({ kind: 'ppt', name: '合法', definition: { ratio: '16:9' } });
    service.setDefault('ppt', saved.id);
    expect(() => service.setDefault('ppt', 'outcome-template-missing')).toThrow();
    expect(service.getDefault('ppt')?.id).toBe(saved.id);
  });

  it('拒绝跨 kind 设置默认模板', () => {
    const ppt = service.save({ kind: 'ppt', name: 'PPT 模板', definition: { ratio: '16:9' } });
    expect(() => service.setDefault('word_formatting', ppt.id)).toThrow();
    expect(service.getDefault('word_formatting')).toBeNull();
  });
});
