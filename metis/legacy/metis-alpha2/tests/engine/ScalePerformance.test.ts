/**
 * 规模压力验证（T32）：万条题录下的检索与列表性能。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';

let tmpDir: string;
let store: PersistenceStore;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-scale-'));
  store = new PersistenceStore(path.join(tmpDir, 'scale.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('规模压力（1 万条题录）', () => {
  it('批量写入 10000 条 + 全文检索 < 300ms', () => {
    const insert = store.raw.prepare(
      'INSERT INTO papers (id, title, authors, year, venue, abstract, doi, arxiv_id, pdf_path, pdf_url, pdf_text, citation_count, tags, notes, read_status, rating, added_at, project_id, reference_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertMany = store.raw.transaction((rows: unknown[][]) => {
      for (const row of rows) insert.run(...row);
    });
    const rows: unknown[][] = [];
    const TOPICS = ['乡村振兴', '基层治理', '数字经济', '社会保障', '教育公平', '环境治理', '基层治理'];
    for (let index = 0; index < 10_000; index += 1) {
      const topic = TOPICS[index % TOPICS.length]!;
      rows.push([
        `paper-scale-${index}`, `${topic}研究第${index}号`, '["作者"]', 2020 + (index % 6), '测试期刊',
        `关于${topic}的摘要`, `10.1000/scale.${index}`, '', '', '', `全文内容：${topic}的深入分析 第${index}篇。`,
        0, '[]', '', 'unread', 0, Date.now() - index, null, '[]',
      ]);
    }
    const insertStart = Date.now();
    insertMany(rows);
    const insertMs = Date.now() - insertStart;

    store.reindexPapersFts();

    const searchStart = Date.now();
    const hits = store.searchLibrary('基层治理 全文', 20);
    const searchMs = Date.now() - searchStart;

    expect(hits.length).toBeGreaterThan(0);
    expect(insertMs).toBeLessThan(20_000); // 批量写入 10s 内（事务批量）
    expect(searchMs).toBeLessThan(300); // 检索 300ms 内（T32 验收标准）
    console.log(`[scale] insert=${insertMs}ms search=${searchMs}ms hits=${hits.length}`);
  });

  it('列表全量读取 10000 条 < 500ms', () => {
    const insert = store.raw.prepare(
      'INSERT INTO papers (id, title, authors, year, venue, abstract, doi, arxiv_id, pdf_path, pdf_url, pdf_text, citation_count, tags, notes, read_status, rating, added_at, project_id, reference_ids) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)',
    );
    const insertMany = store.raw.transaction((rows: unknown[][]) => {
      for (const row of rows) insert.run(...row);
    });
    const rows: unknown[][] = [];
    for (let index = 0; index < 10_000; index += 1) {
      rows.push([`paper-l-${index}`, `标题${index}`, '[]', 2024, '', '', '', '', '', '', '', 0, '[]', '', 'unread', 0, Date.now(), null, '[]']);
    }
    insertMany(rows);

    const start = Date.now();
    const papers = store.getPapers();
    const readMs = Date.now() - start;
    expect(papers.length).toBe(10_000);
    expect(readMs).toBeLessThan(500);
  });
});
