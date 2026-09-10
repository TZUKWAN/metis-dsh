/**
 * NCPSSD parser 单元测试（Phase 15 / Gate E / 任务清单 T14-029~035）。
 * 覆盖：正常检索、无结果、字段缺失、核心标记（白名单判定）、重复去重、
 * 中文字符、页面改版 fail-loud（bad_payload）、type 边缘条目排除。
 */

import { describe, expect, it } from 'vitest';
import {
  buildSearchForm,
  buildSolrWhere,
  escapeSolrTerm,
  parseNcpssdPayload,
} from '../src/ncpssd-parser.ts';

/** 与 NCPSSD 真实响应同构的最小 fixture（字段名/结构一致）。 */
function row(overrides: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    data_id: '70000001',
    title: '<font class="highLight">劳动过程</font>理论的新进展',
    creator: '张三;李四，王五',
    cbw_name: '社会学研究',
    date: '2023-06-15',
    remark: '本文重新审视了劳动过程理论的 core 命题。',
    subject: '社会学;劳动研究',
    type: '中文期刊文章',
    ...overrides,
  };
}

function payload(rows: Record<string, unknown>[], total = rows.length): unknown {
  return { data: { rows, total } };
}

describe('NCPSSD parser', () => {
  it('parses a normal row into a canonical record with core flag from whitelist', () => {
    const result = parseNcpssdPayload(payload([row()]), { coreOnly: true, pageSize: 10 });
    expect(result.records).toHaveLength(1);
    const record = result.records[0]!;
    expect(record.title).toBe('劳动过程理论的新进展');
    expect(record.authors).toEqual([{ name: '张三' }, { name: '李四' }, { name: '王五' }]);
    expect(record.journal).toBe('社会学研究');
    expect(record.year).toBe(2023);
    expect(record.coreStatus).toBe('chinese-core');
    expect(record.url).toContain('ncpssd.org/Literature/articleinfo?id=70000001');
    expect(record.keywords).toEqual(['社会学', '劳动研究']);
  });

  it('returns no results for an empty payload (T14-030)', () => {
    const result = parseNcpssdPayload(payload([]), { coreOnly: false, pageSize: 10 });
    expect(result.records).toHaveLength(0);
    expect(result.total).toBe(0);
  });

  it('excludes non-journal entry types but keeps rows with missing type (T14-031)', () => {
    const result = parseNcpssdPayload(payload([
      row({ title: '年鉴条目', type: '年鉴' }),
      row({ data_id: '70000002', title: '无类型条目', type: undefined }),
      row({ data_id: '70000003', title: '正常期刊条目' }),
    ]), { coreOnly: false, pageSize: 10 });
    const titles = result.records.map((record) => record.title);
    expect(titles).toContain('无类型条目');
    expect(titles).toContain('正常期刊条目');
    expect(titles).not.toContain('年鉴条目');
  });

  it('fails loud on a malformed payload after a site redesign (T14-032)', () => {
    expect(() => parseNcpssdPayload('unexpected string', { coreOnly: false, pageSize: 10 })).toThrow(/bad_payload/);
    expect(() => parseNcpssdPayload(null, { coreOnly: false, pageSize: 10 })).toThrow(/bad_payload/);
  });

  it('marks core journals only via the whitelist, never by inference (T14-033)', () => {
    const result = parseNcpssdPayload(payload([
      row({ data_id: '1', cbw_name: '社会学研究' }),
      row({ data_id: '2', cbw_name: '某非核心刊物', title: '另一篇非核心文章' }),
    ]), { coreOnly: false, pageSize: 10 });
    const byTitle = new Map(result.records.map((record) => [record.title, record.coreStatus]));
    expect(byTitle.get('劳动过程理论的新进展')).toBe('chinese-core');
    expect(byTitle.get('另一篇非核心文章') ?? 'unset').not.toBe('chinese-core');
  });

  it('deduplicates rows sharing the same data_id (T14-034)', () => {
    const result = parseNcpssdPayload(payload([row(), row()]), { coreOnly: false, pageSize: 10 });
    expect(result.records).toHaveLength(1);
  });

  it('keeps Chinese characters through highlight stripping and Solr escaping (T14-035)', () => {
    const escaped = escapeSolrTerm('长江"文化"（新论）\\ 试探');
    expect(escaped).not.toContain('"');
    expect(escaped).toContain('长江');
    expect(escaped).toContain('试探');
    const where = buildSolrWhere('长江文化与人文经济学');
    expect(where).toContain('长江文化与人文经济学');
    expect(where.startsWith('title:("')).toBe(true);
  });
});
