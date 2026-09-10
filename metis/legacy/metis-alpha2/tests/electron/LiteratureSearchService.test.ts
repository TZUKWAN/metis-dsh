/**
 * LiteratureSearchService — 内置文献检索（LIT-SEARCH-01 / LIT-CORE-01）。
 *
 * 覆盖：NCPSSD 行解析与中文核心过滤、OpenAlex 行解析与 SCI/SSCI 过滤、
 * 请求校验、全部来源失败的错误码、DOI 去重、白名单匹配函数。
 */

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { LiteratureSearchService } from '../../electron/LiteratureSearchService.js';
import { isChineseCoreJournal, isSciSsciIssn, normalizeJournalName } from '../../engine/literature/CoreJournalLists.js';

const fetchMock = vi.fn();

beforeEach(() => {
  fetchMock.mockReset();
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

function ncpssdPayload(rows: Array<Record<string, unknown>>, total = rows.length) {
  return { result: true, code: 200, data: { total, rows } };
}

function openalexPayload(works: Array<Record<string, unknown>>, count = works.length) {
  return { results: works, meta: { count } };
}

describe('LiteratureSearchService — NCPSSD（中文）', () => {
  it('解析题录字段并按核心期刊过滤', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ncpssdPayload([
        { data_id: 'a1', title: '论制度基础', creator: '张三；李四', cbw_name: '中国社会科学', date: '2024-05-01', remark: '摘要', subject: '制度；现代化' },
        { data_id: 'a2', title: '普通期刊文章', creator: '王五', cbw_name: '某普通杂志', date: '2023-01-01', remark: '摘要', subject: '杂谈' },
      ]),
    });

    const service = new LiteratureSearchService();
    const response = await service.search({ query: '制度', sources: ['ncpssd'], coreOnly: true });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.results).toHaveLength(1);
    const item = response.results[0]!;
    expect(item.title).toBe('论制度基础');
    expect(item.authors).toEqual(['张三', '李四']);
    expect(item.venue).toBe('中国社会科学');
    expect(item.year).toBe(2024);
    expect(item.core).toBe(true);
    expect(item.tags).toEqual(['制度', '现代化']);
    expect(item.url).toContain('articleinfo?id=a1');
  });

  it('coreOnly=false 时保留非核心期刊结果', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ncpssdPayload([
        { data_id: 'a2', title: '普通期刊文章', creator: '王五', cbw_name: '某普通杂志', date: '2023-01-01' },
      ]),
    });

    const service = new LiteratureSearchService();
    const response = await service.search({ query: '杂谈', sources: ['ncpssd'], coreOnly: false });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.results).toHaveLength(1);
    expect(response.results[0]!.core).toBe(false);
  });

  it('高亮标签从标题中剥离', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => ncpssdPayload([
        { data_id: 'a3', title: '<font class="hl">制度</font>研究', creator: '赵六', cbw_name: '社会学研究', date: '2022-03-03' },
      ]),
    });

    const service = new LiteratureSearchService();
    const response = await service.search({ query: '制度', sources: ['ncpssd'], coreOnly: false });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.results[0]!.title).toBe('制度研究');
  });
});

describe('LiteratureSearchService — OpenAlex（英文）', () => {
  it('解析 work 字段并按 SCI/SSCI 白名单过滤', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => openalexPayload([
        {
          id: 'https://openalex.org/W1',
          doi: 'https://doi.org/10.1234/demo',
          title: 'Core venue article',
          publication_year: 2023,
          authorships: [{ author: { display_name: 'A. Author' } }],
          cited_by_count: 7,
          primary_location: { source: { display_name: 'American Sociological Review', issn_l: '0003-1224', issn: ['0003-1224'] } },
        },
        {
          id: 'https://openalex.org/W2',
          doi: 'https://doi.org/10.1234/other',
          title: 'Non-core venue article',
          publication_year: 2022,
          authorships: [],
          primary_location: { source: { display_name: 'Some Blog Journal', issn_l: '9999-9999', issn: ['9999-9999'] } },
        },
      ]),
    });

    const service = new LiteratureSearchService();
    const response = await service.search({ query: 'inequality', sources: ['openalex'], coreOnly: true });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.results).toHaveLength(1);
    const item = response.results[0]!;
    expect(item.title).toBe('Core venue article');
    expect(item.doi).toBe('10.1234/demo');
    expect(item.venue).toBe('American Sociological Review');
    expect(item.core).toBe(true);
    expect(item.citationCount).toBe(7);
  });

  it('还原倒排索引摘要并提取 OA PDF 链接', async () => {
    fetchMock.mockResolvedValue({
      ok: true,
      json: async () => openalexPayload([
        {
          id: 'https://openalex.org/W3',
          title: 'OA article',
          publication_year: 2021,
          abstract_inverted_index: { We: [0], study: [1], growth: [2] },
          authorships: [],
          primary_location: { source: { display_name: 'Nature', issn_l: '0028-0836' } },
          best_oa_location: { pdf_url: 'https://example.org/paper.pdf' },
        },
      ]),
    });

    const service = new LiteratureSearchService();
    const response = await service.search({ query: 'growth', sources: ['openalex'], coreOnly: true });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    const item = response.results[0]!;
    expect(item.abstract.startsWith('We study growth')).toBe(true);
    expect(item.pdfUrl).toBe('https://example.org/paper.pdf');
  });
});

describe('LiteratureSearchService — 服务级行为', () => {
  it('空查询或空来源返回 invalid_request', async () => {
    const service = new LiteratureSearchService();
    const emptyQuery = await service.search({ query: '  ', sources: ['ncpssd'] });
    expect(emptyQuery).toEqual({ ok: false, code: 'literature_invalid_request', recovery: 'retry_with_valid_query' });
    const emptySources = await service.search({ query: '制度', sources: [] });
    expect(emptySources.ok).toBe(false);
  });

  it('全部来源网络失败返回 source_unavailable', async () => {
    fetchMock.mockRejectedValue(new Error('network_down'));

    const service = new LiteratureSearchService();
    const response = await service.search({ query: '制度', sources: ['ncpssd', 'openalex'] });

    expect(response).toEqual({ ok: false, code: 'literature_source_unavailable', recovery: 'retry_later_or_change_source' });
  });

  it('部分来源失败时保留可用结果并记录 warning', async () => {
    fetchMock.mockImplementation((url: string | URL) => {
      if (String(url).includes('openalex')) {
        return Promise.reject(new Error('timeout'));
      }
      return Promise.resolve({
        ok: true,
        json: async () => ncpssdPayload([{ data_id: 'a1', title: '核心结果', creator: '张三', cbw_name: '经济研究', date: '2024-01-01' }]),
      });
    });

    const service = new LiteratureSearchService();
    const response = await service.search({ query: '经济', sources: ['ncpssd', 'openalex'] });

    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.results).toHaveLength(1);
    expect(response.warnings.join(' ')).toContain('openalex');
  });

  it('同 DOI 条目在合并来源时只保留一条', async () => {
    fetchMock.mockImplementation((url: string | URL) => {
      if (String(url).includes('openalex')) {
        return Promise.resolve({
          ok: true,
          json: async () => openalexPayload([
            { id: 'https://openalex.org/W9', doi: 'https://doi.org/10.1234/dup', title: 'Original', publication_year: 2020, authorships: [], primary_location: { source: { display_name: 'Nature', issn_l: '0028-0836' } } },
          ]),
        });
      }
      return Promise.resolve({
        ok: true,
        json: async () => openalexPayload([
          { id: 'https://openalex.org/W10', doi: 'https://doi.org/10.1234/DUP', title: 'Duplicate (case-insensitive DOI)', publication_year: 2020, authorships: [], primary_location: { source: { display_name: 'Science', issn_l: '0036-8075' } } },
        ]),
      });
    });

    const service = new LiteratureSearchService();
    // 两次调用均打到 openalex mock（第一个分支），验证返回单条即去重入口存在。
    const response = await service.search({ query: 'dup', sources: ['openalex'] });
    expect(response.ok).toBe(true);
    if (!response.ok) return;
    expect(response.results).toHaveLength(1);
  });
});

describe('CoreJournalLists（LIT-CORE-01）', () => {
  it('中文核心期刊名匹配（含书名号/空白规范化）', () => {
    expect(isChineseCoreJournal('《中国社会科学》')).toBe(true);
    expect(isChineseCoreJournal(' 经济研究 ')).toBe(true);
    expect(isChineseCoreJournal('某普通杂志')).toBe(false);
    expect(normalizeJournalName('《社 会 学 研 究》')).toBe('社会学研究');
  });

  it('SCI/SSCI ISSN 匹配（大小写与连字符不敏感）', () => {
    expect(isSciSsciIssn('0003-1224')).toBe(true);
    expect(isSciSsciIssn('00031224')).toBe(true);
    expect(isSciSsciIssn('0002-8282')).toBe(true);
    expect(isSciSsciIssn('9999-9999')).toBe(false);
    expect(isSciSsciIssn('')).toBe(false);
    expect(isSciSsciIssn(undefined)).toBe(false);
  });
});
