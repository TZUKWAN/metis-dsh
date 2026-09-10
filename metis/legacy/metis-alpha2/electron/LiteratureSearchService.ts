/**
 * LiteratureSearchService — 内置文献检索（LIT-SEARCH-01）。
 *
 * 中文：国家哲学社会科学文献中心（NCPSSD）公共检索接口，支持核心期刊过滤。
 * 英文：OpenAlex 开放接口，按 SCI/SSCI 期刊白名单过滤。
 *
 * 每个来源一个适配器，统一返回 LiteratureSearchItem；失败返回带恢复码的
 * 结构化错误，绝不抛出到渲染进程。
 */

import { isChineseCoreJournal, isSciSsciIssn } from '../engine/literature/CoreJournalLists.js';

export type LiteratureSourceId = 'ncpssd' | 'openalex';

export interface LiteratureSearchItem {
  id: string;
  source: LiteratureSourceId;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  doi?: string;
  url?: string;
  pdfUrl?: string;
  citationCount?: number;
  tags: string[];
  /** 中文：CSSCI/北大核心/CSCD；英文：SCI/SSCI。 */
  core: boolean;
  /** OpenAlex 来源 ISSN-L（英文刊；中文库无此字段）。用于投稿匹配的索引层级核验。 */
  issn?: string;
}

export interface LiteratureSearchSuccess {
  ok: true;
  results: LiteratureSearchItem[];
  total: number;
  warnings: string[];
}

export interface LiteratureSearchFailure {
  ok: false;
  code: 'literature_invalid_request' | 'literature_source_unavailable' | 'literature_parse_failed';
  recovery: string;
}

export type LiteratureSearchResponse = LiteratureSearchSuccess | LiteratureSearchFailure;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Metis/0.1';
const NCPSSD_SEARCH_URL = 'https://www.ncpssd.org/searchHandler/search';
const OPENALEX_URL = 'https://api.openalex.org/works';
const OPENALEX_MAILTO = 'metis-workbench@localhost';

function stripHighlight(text: string): string {
  return text.replace(/<\/?(?:font|b|em|i|span)[^>]*>/giu, '').trim();
}

function normalizeText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';
}

async function postForm(url: string, params: Record<string, string>, referer: string): Promise<unknown> {
  const response = await fetch(url, {
    method: 'POST',
    headers: {
      'User-Agent': USER_AGENT,
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json',
      Referer: referer,
      'X-Requested-With': 'XMLHttpRequest',
    },
    body: new URLSearchParams(params).toString(),
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  return response.json();
}

// ─── NCPSSD（中文文献） ─────────────────────────────────────

interface NcpssdRow {
  data_id?: unknown;
  title?: unknown;
  creator?: unknown;
  cbw_name?: unknown;
  date?: unknown;
  remark?: unknown;
  subject?: unknown;
  type?: unknown;
}

function escapeSolrTerm(term: string): string {
  return term.replace(/["()\\]/gu, ' ').trim();
}

async function searchNcpssd(query: string, page: number, pageSize: number, coreOnly: boolean): Promise<{ items: LiteratureSearchItem[]; total: number }> {
  const term = escapeSolrTerm(query);
  const where = `title:("${term}") OR ik_title:(${term}) OR ik_subject:(${term})`;
  // 核心过滤在客户端做：第一页大多是非核心刊物，放大抓取量再截取，避免空结果。
  const fetchSize = coreOnly ? Math.min(100, pageSize * 8) : pageSize;
  const payload = await postForm(NCPSSD_SEARCH_URL, {
    search: where,
    pageNum: String(page),
    pageSize: String(fetchSize),
    sort: 'synUpdateType|DESC,date|DESC,ik_subject|DESC,id|DESC',
    sType: '',
    ajaxKeys: '',
    customShowCondition: '',
  }, 'https://www.ncpssd.org/Literature/articlelist');
  if (typeof payload !== 'object' || payload === null) throw new Error('bad_payload');
  const data = (payload as { data?: { rows?: unknown; total?: unknown } }).data;
  const rows = Array.isArray(data?.rows) ? data.rows as NcpssdRow[] : [];
  const total = typeof data?.total === 'number' ? data.total : rows.length;
  const items: LiteratureSearchItem[] = [];
  for (const row of rows) {
    // 只保留期刊论文，排除年鉴/图书等边缘条目（字段缺失时不过滤）。
    const rowType = String(row.type ?? '');
    if (rowType && rowType !== '中文期刊文章') continue;
    const title = normalizeText(stripHighlight(String(row.title ?? '')), 500);
    if (!title) continue;
    const venue = normalizeText(String(row.cbw_name ?? ''), 200);
    const core = venue ? isChineseCoreJournal(venue) : false;
    if (coreOnly && !core) continue;
    const dataId = normalizeText(String(row.data_id ?? ''), 100);
    const dateText = String(row.date ?? '');
    const yearMatch = /(\d{4})/u.exec(dateText);
    items.push({
      id: `ncpssd:${dataId || title.slice(0, 32)}`,
      source: 'ncpssd',
      title,
      authors: stripHighlight(String(row.creator ?? '')).split(/[;；,，]/u).map((name) => name.trim()).filter(Boolean).slice(0, 12),
      year: yearMatch ? Number(yearMatch[1]) : 0,
      venue,
      abstract: normalizeText(stripHighlight(String(row.remark ?? '')), 1500),
      url: dataId ? `https://www.ncpssd.org/Literature/articleinfo?id=${encodeURIComponent(dataId)}` : undefined,
      tags: stripHighlight(String(row.subject ?? '')).split(/[;；]/u).map((tag) => tag.trim()).filter(Boolean).slice(0, 8),
      core,
    });
  }
  return { items: coreOnly ? items.slice(0, pageSize) : items, total };
}

// ─── OpenAlex（英文文献，SCI/SSCI 白名单过滤） ───────────────

interface OpenAlexWork {
  id?: unknown;
  doi?: unknown;
  title?: unknown;
  publication_year?: unknown;
  type?: unknown;
  abstract_inverted_index?: unknown;
  authorships?: unknown;
  cited_by_count?: unknown;
  primary_location?: unknown;
  open_access?: unknown;
  best_oa_location?: unknown;
}

function abstractFromInvertedIndex(index: unknown): string {
  if (typeof index !== 'object' || index === null) return '';
  const positions: Array<[number, string]> = [];
  for (const [word, offsets] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(offsets)) continue;
    for (const offset of offsets) {
      if (typeof offset === 'number') positions.push([offset, word]);
    }
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, word]) => word).join(' ').slice(0, 1500);
}

async function searchOpenAlex(query: string, page: number, pageSize: number, coreOnly: boolean): Promise<{ items: LiteratureSearchItem[]; total: number }> {
  const params = new URLSearchParams({
    search: query,
    page: String(page),
    'per-page': String(pageSize),
    filter: 'type:article|review',
    mailto: OPENALEX_MAILTO,
  });
  const response = await fetch(`${OPENALEX_URL}?${params.toString()}`, {
    headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
    signal: AbortSignal.timeout(20_000),
  });
  if (!response.ok) throw new Error(`http_${response.status}`);
  const payload = await response.json() as { results?: unknown; meta?: { count?: unknown } };
  const works = Array.isArray(payload.results) ? payload.results as OpenAlexWork[] : [];
  const total = typeof payload.meta?.count === 'number' ? payload.meta.count : works.length;
  const items: LiteratureSearchItem[] = [];
  for (const work of works) {
    const title = normalizeText(String(work.title ?? ''), 500);
    if (!title) continue;
    const location = work.primary_location as { source?: { display_name?: unknown; issn_l?: unknown; issn?: unknown } } | undefined;
    const venue = normalizeText(String(location?.source?.display_name ?? ''), 200);
    const issnL = normalizeText(String(location?.source?.issn_l ?? ''), 20);
    const issnList = Array.isArray(location?.source?.issn) ? (location.source.issn as unknown[]).map((v) => String(v)) : [];
    const core = isSciSsciIssn(issnL) || issnList.some((issn) => isSciSsciIssn(issn));
    if (coreOnly && !core) continue;
    const authorsRaw = Array.isArray(work.authorships) ? work.authorships : [];
    const authors = authorsRaw
      .map((entry) => normalizeText(String((entry as { author?: { display_name?: unknown } })?.author?.display_name ?? ''), 120))
      .filter(Boolean)
      .slice(0, 12);
    const oa = work.open_access as { oa_url?: unknown } | undefined;
    const bestOa = work.best_oa_location as { pdf_url?: unknown } | undefined;
    const pdfUrl = normalizeText(String(bestOa?.pdf_url ?? ''), 1000) || normalizeText(String(oa?.oa_url ?? ''), 1000);
    items.push({
      id: `openalex:${normalizeText(String(work.id ?? ''), 120) || title.slice(0, 32)}`,
      source: 'openalex',
      title,
      authors,
      year: typeof work.publication_year === 'number' ? work.publication_year : 0,
      venue,
      abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
      doi: normalizeText(String(work.doi ?? ''), 200).replace(/^https?:\/\/doi\.org\//iu, '') || undefined,
      url: normalizeText(String(work.id ?? ''), 1000) || undefined,
      pdfUrl: pdfUrl || undefined,
      citationCount: typeof work.cited_by_count === 'number' ? work.cited_by_count : undefined,
      tags: [],
      core,
      issn: issnL || issnList[0] || undefined,
    });
  }
  return { items, total };
}

// ─── 服务入口 ────────────────────────────────────────────────

export class LiteratureSearchService {
  async search(request: {
    query: string;
    sources: LiteratureSourceId[];
    page?: number;
    pageSize?: number;
    coreOnly?: boolean;
  }): Promise<LiteratureSearchResponse> {
    const query = request.query.trim().slice(0, 200);
    const sources = request.sources.filter((source) => source === 'ncpssd' || source === 'openalex');
    if (!query || sources.length === 0) {
      return { ok: false, code: 'literature_invalid_request', recovery: 'retry_with_valid_query' };
    }
    const page = Math.max(1, Math.min(50, request.page ?? 1));
    const pageSize = Math.max(5, Math.min(25, request.pageSize ?? 10));
    const coreOnly = request.coreOnly !== false;

    const results: LiteratureSearchItem[] = [];
    const warnings: string[] = [];
    let total = 0;
    const settled = await Promise.allSettled(sources.map(async (source) => {
      return source === 'ncpssd'
        ? searchNcpssd(query, page, pageSize, coreOnly)
        : searchOpenAlex(query, page, pageSize, coreOnly);
    }));
    for (let index = 0; index < settled.length; index += 1) {
      const outcome = settled[index]!;
      const source = sources[index]!;
      if (outcome.status === 'fulfilled') {
        results.push(...outcome.value.items);
        total += outcome.value.total;
      } else {
        warnings.push(`${source}:${String(outcome.reason instanceof Error ? outcome.reason.message : outcome.reason).slice(0, 80)}`);
      }
    }
    if (results.length === 0 && warnings.length === sources.length) {
      return { ok: false, code: 'literature_source_unavailable', recovery: 'retry_later_or_change_source' };
    }
    // 去重：DOI 优先，其次 标题+年份。
    const seen = new Set<string>();
    const deduped = results.filter((item) => {
      const key = item.doi ? `doi:${item.doi.toLowerCase()}` : `t:${item.title.toLowerCase()}|${item.year}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });
    return { ok: true, results: deduped, total, warnings };
  }
}
