/**
 * JournalCorpusService — 学术投稿生命周期 P1：目标期刊写作范式参考语料构建。
 *
 * 数据来源：
 *  - 有 ISSN：OpenAlex works API 按 primary_location.source.issn 过滤真实发表记录；
 *  - 无 ISSN：fallback 走 LiteratureSearchService（OpenAlex + NCPSSD），再按
 *    venue/issn 过滤出真实归属该刊的条目。
 *
 * 诚实性边界：条目只来自检索 API 的真实响应；相似度是确定性的分词共现打分；
 * OpenAlex 不可用或检索失败时结构化返回，不产出任何兜底假数据。
 */

import type {
  JournalCorpusItem,
  JournalCorpusItemCreateInput,
} from '../engine/submission/JournalProfileContract.js';
import type { JournalProfileRepository } from './JournalProfileRepository.js';
import { LiteratureSearchService, type LiteratureSearchItem } from './LiteratureSearchService.js';

export interface JournalCorpusServiceOptions {
  repository: JournalProfileRepository;
  /** 可注入的文献检索服务（无 ISSN 的 fallback 路径使用）；缺省时新建默认实例。 */
  literatureSearch?: Pick<LiteratureSearchService, 'search'>;
  /** 测试可注入的当前年份，用于 recency 加权。 */
  currentYear?: number;
}

export type JournalCorpusFailureCode =
  | 'journal_profile_not_found'
  | 'journal_snapshot_not_found'
  | 'corpus_source_unavailable';

export interface JournalCorpusFailure {
  ok: false;
  code: JournalCorpusFailureCode;
  message: string;
}

export interface ManuscriptInfo {
  title: string;
  abstract?: string;
  keywords?: string[];
}

export type BuildCorpusResult =
  | { ok: true; items: JournalCorpusItem[] }
  | JournalCorpusFailure;

const USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Metis/0.1';
const OPENALEX_MAILTO = 'metis-workbench@localhost';
const OPENALEX_WORKS_URL = 'https://api.openalex.org/works';
const FETCH_TIMEOUT_MS = 20_000;
const FETCH_PER_PAGE = 25;
const DEFAULT_LIMIT = 15;
const RECENCY_WINDOW_YEARS = 5;

function failure(code: JournalCorpusFailureCode, message: string): JournalCorpusFailure {
  return { ok: false, code, message };
}

// ─── OpenAlex works 解析 ────────────────────────────────────

interface OpenAlexWork {
  id?: unknown;
  doi?: unknown;
  title?: unknown;
  publication_year?: unknown;
  abstract_inverted_index?: unknown;
  authorships?: unknown;
  primary_location?: unknown;
  open_access?: unknown;
  best_oa_location?: unknown;
}

function asText(value: unknown, max: number): string {
  return typeof value === 'string' ? value.replace(/\s+/gu, ' ').trim().slice(0, max) : '';
}

/** OpenAlex 摘要是 inverted index，需要按位置还原为文本。 */
export function abstractFromInvertedIndex(index: unknown): string {
  if (typeof index !== 'object' || index === null) return '';
  const positions: Array<[number, string]> = [];
  for (const [word, offsets] of Object.entries(index as Record<string, unknown>)) {
    if (!Array.isArray(offsets)) continue;
    for (const offset of offsets) {
      if (typeof offset === 'number') positions.push([offset, word]);
    }
  }
  positions.sort((a, b) => a[0] - b[0]);
  return positions.map(([, word]) => word).join(' ').slice(0, 50_000);
}

function workToCorpusInput(work: OpenAlexWork, issn: string): JournalCorpusItemCreateInput | null {
  const title = asText(work.title, 1000);
  if (!title) return null;
  const location = work.primary_location as { source?: { display_name?: unknown } } | undefined;
  const authorsRaw = Array.isArray(work.authorships) ? work.authorships : [];
  const authors = authorsRaw
    .map((entry) => asText((entry as { author?: { display_name?: unknown } })?.author?.display_name, 300))
    .filter(Boolean)
    .slice(0, 12);
  const oa = work.open_access as { is_oa?: unknown; oa_url?: unknown } | undefined;
  const doi = asText(work.doi, 300).replace(/^https?:\/\/doi\.org\//iu, '');
  return {
    title,
    authors,
    year: typeof work.publication_year === 'number' ? work.publication_year : null,
    doi,
    url: asText(work.id, 2000) || (doi ? `https://doi.org/${doi}` : ''),
    abstract: abstractFromInvertedIndex(work.abstract_inverted_index),
    source: 'openalex',
    venueName: asText(location?.source?.display_name, 300),
    issn,
    fulltextAvailable: oa?.is_oa === true || Boolean(work.best_oa_location),
  };
}

// ─── 相似度打分（确定性：中文 bigram + 英文 token 共现） ──────

/** 分词：英文/数字按 token，中文按字符 bigram。 */
export function tokenize(text: string): Set<string> {
  const tokens = new Set<string>();
  const lower = text.toLowerCase();
  for (const match of lower.matchAll(/[a-z][a-z0-9-]{1,}/gu)) {
    tokens.add(`w:${match[0]}`);
  }
  const han = lower.replace(/[^\p{Script=Han}]/gu, '');
  for (let index = 0; index + 1 < han.length; index += 1) {
    tokens.add(`h:${han.slice(index, index + 2)}`);
  }
  if (han.length === 1) tokens.add(`h:${han}`);
  return tokens;
}

/** 余弦式共现系数：|A∩B| / sqrt(|A|·|B|)，输出 0-1。 */
export function similarityScore(manuscript: ManuscriptInfo, candidate: { title: string; abstract: string }): number {
  const queryTokens = tokenize([manuscript.title, manuscript.abstract ?? '', ...(manuscript.keywords ?? [])].join(' '));
  const candidateTokens = tokenize(`${candidate.title} ${candidate.abstract}`);
  if (queryTokens.size === 0 || candidateTokens.size === 0) return 0;
  let overlap = 0;
  for (const token of queryTokens) {
    if (candidateTokens.has(token)) overlap += 1;
  }
  return overlap / Math.sqrt(queryTokens.size * candidateTokens.size);
}

function normalizeVenue(name: string): string {
  return name.toLowerCase().replace(/[^a-z0-9\p{Script=Han}]+/gu, '');
}

/** fallback 路径下判断检索条目是否真实归属目标期刊。 */
function belongsToJournal(item: LiteratureSearchItem, canonicalName: string): boolean {
  const target = normalizeVenue(canonicalName);
  if (!target) return false;
  const venue = normalizeVenue(item.venue);
  return Boolean(venue) && (venue.includes(target) || target.includes(venue));
}

export class JournalCorpusService {
  constructor(private readonly options: JournalCorpusServiceOptions) {}

  private get repository(): JournalProfileRepository {
    return this.options.repository;
  }

  private async fetchByIssn(issn: string): Promise<JournalCorpusItemCreateInput[]> {
    const params = new URLSearchParams({
      filter: `primary_location.source.issn:${issn}`,
      sort: 'publication_date:desc',
      'per-page': String(FETCH_PER_PAGE),
      mailto: OPENALEX_MAILTO,
    });
    const response = await fetch(`${OPENALEX_WORKS_URL}?${params.toString()}`, {
      headers: { 'User-Agent': USER_AGENT, Accept: 'application/json' },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!response.ok) throw new Error(`http_${response.status}`);
    const payload = await response.json() as { results?: unknown };
    const works = Array.isArray(payload.results) ? payload.results as OpenAlexWork[] : [];
    return works.map((work) => workToCorpusInput(work, issn)).filter((item): item is JournalCorpusItemCreateInput => item !== null);
  }

  private async fetchBySearchFallback(canonicalName: string): Promise<JournalCorpusItemCreateInput[]> {
    const search = this.options.literatureSearch ?? new LiteratureSearchService();
    const response = await search.search({
      query: canonicalName,
      sources: ['openalex', 'ncpssd'],
      pageSize: 25,
      coreOnly: false,
    });
    if (!response.ok) throw new Error(response.code);
    return response.results
      .filter((item) => belongsToJournal(item, canonicalName))
      .map((item) => ({
        title: item.title,
        authors: item.authors,
        year: item.year > 0 ? item.year : null,
        doi: item.doi ?? '',
        url: item.url ?? '',
        abstract: item.abstract,
        source: item.source === 'ncpssd' ? 'ncpssd' as const : 'openalex' as const,
        venueName: item.venue,
        issn: item.issn ?? '',
        fulltextAvailable: Boolean(item.pdfUrl),
      }));
  }

  /** 为目标期刊构建写作范式参考语料并落库。 */
  async buildCorpus(input: {
    projectId: string;
    profileId: string;
    snapshotId?: string | null;
    manuscript: ManuscriptInfo;
    limit?: number;
  }): Promise<BuildCorpusResult> {
    const profile = this.repository.getProfile(input.projectId, input.profileId);
    if (!profile) return failure('journal_profile_not_found', '期刊档案不存在或不属于当前项目。');
    if (input.snapshotId) {
      const snapshot = this.repository.getSnapshot(input.snapshotId);
      if (!snapshot || snapshot.profileId !== profile.id) {
        return failure('journal_snapshot_not_found', '研究快照不存在或不属于该期刊档案。');
      }
    }
    const limit = Math.max(1, Math.min(50, input.limit ?? DEFAULT_LIMIT));

    let candidates: JournalCorpusItemCreateInput[];
    try {
      candidates = profile.issn
        ? await this.fetchByIssn(profile.issn)
        : await this.fetchBySearchFallback(profile.canonicalName);
    } catch (error) {
      return failure('corpus_source_unavailable', `语料来源不可用：${error instanceof Error ? error.message : String(error)}`);
    }

    // 批内去重（doi 优先，其次规范化标题），跨批去重由仓储负责。
    const seen = new Set<string>();
    const unique = candidates.filter((item) => {
      const key = item.doi ? `doi:${item.doi.toLowerCase()}` : `t:${(item.title ?? '').trim().toLowerCase().replace(/\s+/gu, ' ')}`;
      if (!item.title || seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const currentYear = this.options.currentYear ?? new Date().getFullYear();
    const scored = unique.map((item) => {
      const similarity = similarityScore(input.manuscript, { title: item.title ?? '', abstract: item.abstract ?? '' });
      const age = item.year !== null && item.year !== undefined ? Math.max(0, currentYear - item.year) : RECENCY_WINDOW_YEARS + 1;
      // 近 5 年内 recency 从 1 线性衰减到 0.5，更早固定 0.5，未知年份按最旧处理。
      const recency = Math.max(0.5, 1 - (age / RECENCY_WINDOW_YEARS) * 0.5);
      return { item, similarity, rank: 0.7 * similarity + 0.3 * recency };
    });
    scored.sort((a, b) => b.rank - a.rank);

    const selected = scored.slice(0, limit).map(({ item, similarity }) => ({
      ...item,
      similarityScore: Math.round(similarity * 1000) / 1000,
    }));
    const added = this.repository.addCorpusItems(profile.id, input.snapshotId ?? null, selected);
    // 仓储按 created_at 排序（同事务内同毫秒不保序）；按打分顺序重排返回，保持排名语义。
    const keyOf = (item: { doi: string; title: string }): string =>
      item.doi ? `doi:${item.doi.toLowerCase()}` : `t:${item.title.trim().toLowerCase().replace(/\s+/gu, ' ')}`;
    const addedByKey = new Map(added.map((item) => [keyOf(item), item]));
    const ordered = selected.map((item) => addedByKey.get(keyOf({ doi: item.doi ?? '', title: item.title ?? '' })))
      .filter((item): item is JournalCorpusItem => item !== undefined);
    return { ok: true, items: ordered };
  }
}
