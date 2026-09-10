/**
 * PersistenceStore.searchLibrary — 中文全文检索修复（T2）。
 *
 * 回归背景：旧分词只保留 a-z0-9，中文查询被清空导致检索恒为空。
 */

import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { PersistenceStore } from '../../engine/persistence/PersistenceStore.js';

let store: PersistenceStore;
let tmpDir: string;

beforeEach(() => {
  tmpDir = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-cn-search-'));
  store = new PersistenceStore(path.join(tmpDir, 'test.db'));
});

afterEach(() => {
  store.close();
  fs.rmSync(tmpDir, { recursive: true, force: true });
});

describe('searchLibrary 中文检索', () => {
  it('中文关键词命中题录与 PDF 全文', () => {
    store.savePaper({
      id: 'p-cn-1',
      title: '乡村振兴背景下的基层治理创新',
      authors: ['张三'],
      year: 2024,
      venue: '社会学研究',
      abstract: '本文讨论乡村振兴与基层治理的互动机制。',
      pdfText: '[p1] 全文第一段：乡村振兴战略推动了基层治理转型。',
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: Date.now(),
    });
    const hits = store.searchLibrary('乡村振兴', 5).filter((hit) => hit.type === 'paper');
    expect(hits.length).toBe(1);
    expect(hits[0]!.id).toBe('p-cn-1');
  });

  it('命中片段包含关键词上下文而非固定摘要前缀', () => {
    const filler = '前言'.repeat(120);
    store.savePaper({
      id: 'p-cn-2',
      title: '测试论文',
      authors: [],
      year: 2023,
      venue: '',
      abstract: '',
      pdfText: `[p1] ${filler} 财政转移支付对公共服务均等化具有显著正向作用 ${filler}`,
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: Date.now(),
    });
    const hits = store.searchLibrary('财政转移支付', 5).filter((hit) => hit.type === 'paper');
    expect(hits.length).toBe(1);
    expect(hits[0]!.snippet).toContain('财政转移支付');
    expect(hits[0]!.snippet).toContain('公共服务');
    expect(hits[0]!.snippet.startsWith('前言前言')).toBe(false);
  });

  it('英文查询行为不回归', () => {
    store.savePaper({
      id: 'p-en-1',
      title: 'Attention Is All You Need',
      authors: ['Vaswani'],
      year: 2017,
      venue: 'NeurIPS',
      abstract: 'Transformer architecture',
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
      addedAt: Date.now(),
    });
    expect(store.searchLibrary('transformer', 5).some((hit) => hit.id === 'p-en-1')).toBe(true);
    expect(store.searchLibrary('attention', 5).some((hit) => hit.id === 'p-en-1')).toBe(true);
  });
});
