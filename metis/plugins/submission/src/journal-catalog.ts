/**
 * Journal catalog access over two human-curated directory sites:
 *  - LetPub (letpub.com.cn) — international SCI/SSCI journals: subject tree,
 *    impact metrics, CAS partition, warning list, official site and the
 *    real submission URL (base64-encoded in a click-log attribute).
 *  - Wanwei Shukan (eshukan.com) — Chinese journals: category tree, per-journal
 *    submission channel (email / online system / editorial contact) and
 *    author-submitted review experiences.
 *
 * Both sites are server-rendered HTML without a public API, so every parser
 * below works on raw HTML with tolerant regexes anchored on stable markers
 * that were verified against saved fixtures (tests/fixtures/journal-catalog).
 * Parsers are pure functions so they can be tested fully offline.
 */

export type JournalCatalogSource = 'letpub' | 'eshukan';

export const JOURNAL_CATALOG_SOURCES: readonly JournalCatalogSource[] = ['letpub', 'eshukan'];

export interface CatalogFieldOption {
  id: string;
  name: string;
}

export interface CatalogJournalSummary {
  source: JournalCatalogSource;
  id: string;
  name: string;
  nameAbbr?: string;
  issn?: string;
  /** e.g. 官网投稿 / Email投稿 / 知网系统投稿 (eshukan list annotation). */
  submissionLabel?: string;
  /** Row-level badges such as 中文核心（2023年版）/ CSCD核心 (eshukan). */
  categoryTags: string[];
  detailUrl: string;
}

export interface CatalogSearchResult {
  source: JournalCatalogSource;
  field: CatalogFieldOption | null;
  keyword: string;
  page: number;
  totalHint?: string;
  journals: CatalogJournalSummary[];
  /** When the requested field name did not match exactly, offer close options. */
  fieldCandidates?: CatalogFieldOption[];
  note?: string;
}

export interface CatalogJournalDetail {
  source: JournalCatalogSource;
  id: string;
  name?: string;
  detailUrl: string;
  issn?: string;
  eissn?: string;
  cn?: string;
  publisher?: string;
  supervisor?: string;
  hostInstitution?: string;
  language?: string;
  officialWebsite?: string;
  submissionUrl?: string;
  submissionEmails: string[];
  phone?: string;
  reviewCycle?: string;
  acceptanceRatio?: string;
  articleProcessingCharge?: string;
  warningStatus?: string;
  indexingTags: string[];
  /** 征稿启事 / submission requirements text (eshukan). */
  submissionNotice?: string;
}

// ─── HTTP ────────────────────────────────────────────────────────

const LETPUB_BASE = 'https://www.letpub.com.cn';
const ESHUKAN_BASE = 'https://www.eshukan.com';
const CATALOG_USER_AGENT = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36';
const FETCH_TIMEOUT_MS = 20_000;
const MAX_BODY_CHARS = 2_000_000;

export class JournalCatalogFetchError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'JournalCatalogFetchError';
  }
}

export type CatalogPageFetcher = (url: string, init?: RequestInit) => Promise<Response>;

let customPageFetcher: CatalogPageFetcher | null = null;

/**
 * Hosts (electron main) inject a Chromium-stack fetcher here so directory
 * requests follow system/env proxy rules — some catalog sites are only
 * reachable through a local proxy. Pure Node callers keep global fetch.
 */
export function configureJournalCatalogFetcher(fetcher: CatalogPageFetcher | null): void {
  customPageFetcher = fetcher;
}

async function fetchCatalogPage(url: string): Promise<string> {
  let parsed: URL;
  try {
    parsed = new URL(url);
  } catch {
    throw new JournalCatalogFetchError('catalog_url_invalid');
  }
  if (parsed.protocol !== 'https:' && parsed.protocol !== 'http:') {
    throw new JournalCatalogFetchError('catalog_protocol_not_allowed');
  }
  const requestInit: RequestInit = {
    headers: { 'User-Agent': CATALOG_USER_AGENT },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  };
  const response = customPageFetcher
    ? await customPageFetcher(parsed.toString(), requestInit)
    : await fetch(parsed, requestInit);
  if (!response.ok) throw new JournalCatalogFetchError(`catalog_http_${response.status}`);
  const body = await response.text();
  return body.length > MAX_BODY_CHARS ? body.slice(0, MAX_BODY_CHARS) : body;
}

// ─── HTML helpers ────────────────────────────────────────────────

const NAMED_ENTITIES: Record<string, string> = {
  nbsp: ' ', amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", middot: '·', mdash: '—', ndash: '–', hellip: '…',
};

export function decodeHtmlEntities(input: string): string {
  return input
    .replace(/&#x([0-9a-fA-F]+);/g, (_m, hex: string) => safeCodePoint(parseInt(hex, 16)))
    .replace(/&#(\d+);/g, (_m, dec: string) => safeCodePoint(parseInt(dec, 10)))
    .replace(/&([a-zA-Z]+);/g, (m, name: string) => NAMED_ENTITIES[name] ?? m);
}

function safeCodePoint(code: number): string {
  return Number.isFinite(code) && code > 0 && code <= 0x10ffff ? String.fromCodePoint(code) : '';
}

/** Strips scripts/styles/tags and collapses whitespace into single spaces. */
export function htmlToText(html: string): string {
  return decodeHtmlEntities(
    html
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<!--[\s\S]*?-->/g, ' ')
      .replace(/<[^>]+>/g, ' '),
  ).replace(/\s+/g, ' ').trim();
}

function stripTags(value: string): string {
  return decodeHtmlEntities(value.replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
}

function firstMatch(text: string, pattern: RegExp): string | undefined {
  const match = pattern.exec(text);
  return match ? match[1]?.trim() || undefined : undefined;
}

// ─── LetPub parsing ──────────────────────────────────────────────

/**
 * Subject-tree options: anchors shaped `href="…fieldtag=N&firstletter=">名称</a>`.
 * The page repeats each anchor thousands of times (sidebar + per-row), so dedupe by id.
 */
export function parseLetPubFieldOptions(html: string): CatalogFieldOption[] {
  const options = new Map<string, string>();
  const pattern = /href="[^"]*fieldtag=(\d+)&firstletter="[^>]*>([^<]{2,30})</g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const id = match[1]!;
    const name = decodeHtmlEntities(match[2]!).trim();
    if (!options.has(id) && name) options.set(id, name);
  }
  return [...options.entries()].map(([id, name]) => ({ id, name }));
}

export interface LetPubJournalList {
  journals: CatalogJournalSummary[];
  totalHint?: string;
}

/** List rows: ISSN cell followed by the detail anchor and a grey abbreviation. */
export function parseLetPubJournalList(html: string, page = 1): LetPubJournalList {
  const journals: CatalogJournalSummary[] = [];
  const rowPattern = /<tr><td[^>]*>(\d{4}-\d{3}[\dXx])<\/td>\s*<td[^>]*>\s*<a[^>]*href="[^"]*journalid=(\d+)[^"]*"[^>]*>([^<]{1,180})<\/a>(?:<br>\s*<br>\s*<font[^>]*>([^<]{0,120})<\/font>)?/gi;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(html)) !== null) {
    const id = match[2]!;
    if (journals.some((item) => item.id === id)) continue;
    journals.push({
      source: 'letpub',
      id,
      name: decodeHtmlEntities(match[3]!).trim(),
      nameAbbr: match[4] ? decodeHtmlEntities(match[4]).trim() || undefined : undefined,
      issn: match[1],
      categoryTags: [],
      detailUrl: `${LETPUB_BASE}/index.php?journalid=${id}&page=journalapp&view=detail`,
    });
  }
  const text = htmlToText(html);
  const matched = /匹配[:：]?\s*(\d[\d,]*)\s*条记录/u.exec(text)?.[1]
    ?? /共\s*(\d[\d,]*)\s*条/u.exec(text)?.[1];
  return {
    journals,
    totalHint: matched ? `${matched} 条（第 ${page} 页，每页 10 条）` : undefined,
  };
}

/**
 * LetPub hides the real official/submission URLs behind a click tracker; the
 * plain-text destination is base64 in the third addclicklog argument. An empty
 * argument means the field is not filled for this journal.
 */
function extractLetPubClicklogUrl(html: string, channel: string): string | undefined {
  const pattern = new RegExp(
    `addclicklog\\\\?\\(\\\\?\\s*\\\\?'期刊信息系统\\\\?'\\s*,\\s*\\\\?'${channel}\\\\?'\\s*,\\s*\\\\?'([A-Za-z0-9+/=]*)\\\\?'`,
    'u',
  );
  const encoded = pattern.exec(html)?.[1];
  if (!encoded) return undefined;
  try {
    const decoded = Buffer.from(encoded, 'base64').toString('utf8');
    return /^https?:\/\//u.test(decoded) ? decoded : undefined;
  } catch {
    return undefined;
  }
}

/** Reads a label→value table cell pair, tolerating mixed <td>/<TD> casing. */
function extractLetPubField(html: string, label: string): string | undefined {
  const pattern = new RegExp(`>${label}\\s*</td>\\s*<t[dD][^>]*>([\\s\\S]{0,600}?)</t[dD]>`, 'i');
  const raw = pattern.exec(html)?.[1];
  if (!raw) return undefined;
  const value = stripTags(raw);
  if (!value || /注册或登录/u.test(value)) return undefined;
  return value;
}

export function parseLetPubDetail(html: string, id: string): CatalogJournalDetail {
  const text = htmlToText(html);
  const titleName = /【LetPub】\s*([^【<]{2,120}?)\s*影响因子/u.exec(html)?.[1]?.trim();
  // Title wins: the page body repeats 期刊名称 rows in the "similar journals"
  // table, which would otherwise shadow the requested journal.
  const name = titleName ?? extractLetPubField(html, '期刊名称') ?? extractLetPubField(html, '期刊名');
  const reviewCycleMatch = /平均审稿速度\s*网友分享经验[:：]\s*(.*?)\s*平均录用比例/u.exec(text);
  const acceptanceMatch = /平均录用比例\s*网友分享经验[:：]\s*(.*?)\s*版面费/u.exec(text);
  let warningStatus: string | undefined;
  if (/不在预警名单/u.test(text)) warningStatus = '不在预警名单中';
  else if (/列入.{0,8}预警/u.test(text)) warningStatus = '存在预警记录，需人工核实';
  // Lookbehind keeps E-ISSN from being consumed as a plain ISSN hit.
  const issnFromBody = /(?<![A-Za-z-])ISSN[:：]?\s*(\d{4}-\d{3}[\dXx])/iu.exec(text)?.[1];
  return {
    source: 'letpub',
    id,
    name,
    detailUrl: `${LETPUB_BASE}/index.php?journalid=${id}&page=journalapp&view=detail`,
    issn: issnFromBody,
    eissn: extractLetPubField(html, 'E-ISSN'),
    publisher: firstMatch(text, /出版商\s*([^\s][^被]{0,60}?)(?=\s*涉及的研究方向|\s*出版国家|\s*出版语言|$)/u),
    language: firstMatch(text, /出版语言\s*([^\s]{1,30})/u),
    officialWebsite: extractLetPubClicklogUrl(html, '期刊官方网站'),
    submissionUrl: extractLetPubClicklogUrl(html, '期刊投稿网址'),
    submissionEmails: [],
    reviewCycle: reviewCycleMatch?.[1]?.trim() || undefined,
    acceptanceRatio: acceptanceMatch?.[1]?.trim() || undefined,
    articleProcessingCharge: firstMatch(text, /文章处理费[:：]\s*([^\s]{1,24})/u),
    warningStatus,
    indexingTags: [],
  };
}

// ─── Eshukan parsing ─────────────────────────────────────────────

/** Category anchors use single quotes: `<a href='/secondchannel.aspx?typeid=N'>名称</a>`. */
export function parseEshukanCategories(html: string): CatalogFieldOption[] {
  const options = new Map<string, string>();
  const pattern = /href=['"][^'"]*secondchannel\.aspx\?typeid=(\d+)[^'"]*['"][^>]*>([^<]{2,24})</g;
  let match: RegExpExecArray | null;
  while ((match = pattern.exec(html)) !== null) {
    const id = match[1]!;
    const name = decodeHtmlEntities(match[2]!).trim();
    // Longest name wins: the tree nests broader and narrower categories that
    // repeat the same typeid anchor for parent navigation.
    const existing = options.get(id);
    if (!existing || name.length >= existing.length) options.set(id, name);
  }
  return [...options.entries()].map(([id, name]) => ({ id, name }));
}

export function parseEshukanJournalList(html: string, page = 1): LetPubJournalList {
  const journals: CatalogJournalSummary[] = [];
  const rowPattern = /href=['"]displayj\.aspx\?jid=(\d+)[^'">]*['"][^>]*>([^<]{2,80})<\/a>((?:(?!displayj\.aspx)[\s\S]){0,300})/gi;
  let match: RegExpExecArray | null;
  while ((match = rowPattern.exec(html)) !== null) {
    const id = match[1]!;
    if (journals.some((item) => item.id === id)) continue;
    const tags: string[] = [];
    const tagPattern = /<span[^>]*>([^<]{2,26})<\/span>/g;
    let tagMatch: RegExpExecArray | null;
    const tail = match[3] ?? '';
    while ((tagMatch = tagPattern.exec(tail)) !== null) {
      const tag = decodeHtmlEntities(tagMatch[1]!).trim();
      if (tag && !tags.includes(tag) && tags.length < 4) tags.push(tag);
    }
    journals.push({
      source: 'eshukan',
      id,
      name: decodeHtmlEntities(match[2]!).trim(),
      submissionLabel: tags[0],
      categoryTags: tags.slice(1),
      detailUrl: `${ESHUKAN_BASE}/displayj.aspx?jid=${id}`,
    });
  }
  const text = htmlToText(html);
  const total = /共(\d+)\s*条记录/.exec(text)?.[1];
  return {
    journals,
    totalHint: total ? `${total} 条（第 ${page} 页，每页约 40 条）` : undefined,
  };
}

const ESHUKAN_INDEXING_WORDS = ['知网收录', '万方收录', '维普收录', '第一批认定学术期刊', '第二批认定学术期刊'];

export function parseEshukanDetail(html: string, id: string): CatalogJournalDetail {
  const text = htmlToText(html);
  const emails = new Set<string>();
  const inlineEmail = /刊内邮箱[^：:]*[:：]\s*([A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,6})/u.exec(text)?.[1];
  if (inlineEmail) emails.add(inlineEmail);
  const emailPattern = /([A-Za-z0-9._%+-]{2,}@[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+\.[A-Za-z]{2,6})/gu;
  let emailMatch: RegExpExecArray | null;
  while ((emailMatch = emailPattern.exec(text)) !== null && emails.size < 3) {
    const candidate = emailMatch[1]!.toLowerCase();
    if (!candidate.endsWith('.png') && !candidate.endsWith('.gif') && !candidate.endsWith('.jpg')) emails.add(candidate);
  }
  const noticeIndex = text.indexOf('征稿启事');
  const submissionNotice = noticeIndex >= 0 ? text.slice(noticeIndex, noticeIndex + 1200) : undefined;
  const indexingTags = ESHUKAN_INDEXING_WORDS.filter((word) => text.includes(word));
  const cnMatch = /CN\s*(\d{2}-\d{3,4}\/[A-Z])/iu.exec(text)?.[1];
  const issnMatch = /ISSN\s*(\d{4}-\d{3}[\dXx])/iu.exec(text)?.[1];
  return {
    source: 'eshukan',
    id,
    name: firstMatch(text, /《([^《》]{2,60})》/u),
    detailUrl: `${ESHUKAN_BASE}/displayj.aspx?jid=${id}`,
    issn: issnMatch,
    cn: cnMatch,
    supervisor: firstMatch(text, /主\s*管[：:]\s*([^\s].{0,50}?)(?=\s*主办|\s*刊期|$)/u),
    hostInstitution: firstMatch(text, /主办[：:]\s*([^\s].{0,60}?)(?=\s*刊期|\s*邮发|\s*地址|$)/u),
    officialWebsite: undefined,
    submissionUrl: firstMatch(text, /网址[:：]\s*((?:https?:\/\/|www\.)[^\s，。；,;]+)/iu),
    submissionEmails: [...emails],
    phone: firstMatch(text, /(0\d{2,3}\s*[-—–]\s*\d{7,8})/u),
    indexingTags,
    submissionNotice,
  };
}

// ─── Field/category resolution ───────────────────────────────────

/** Exact match first, then containment in either direction; returns at most `limit`. */
export function matchFieldOptions(options: CatalogFieldOption[], query: string, limit = 12): CatalogFieldOption[] {
  const needle = query.trim();
  if (!needle) return [];
  const exact = options.filter((option) => option.name === needle);
  if (exact.length > 0) return exact.slice(0, limit);
  const contained = options.filter((option) => option.name.includes(needle) || needle.includes(option.name));
  return contained.slice(0, limit);
}

// ─── Cached directory listings ───────────────────────────────────

const FIELD_CACHE_TTL_MS = 30 * 60 * 1000;

interface FieldCache {
  options: CatalogFieldOption[];
  fetchedAt: number;
}

const fieldCaches = new Map<JournalCatalogSource, FieldCache>();

async function loadCatalogFields(source: JournalCatalogSource): Promise<CatalogFieldOption[]> {
  const cached = fieldCaches.get(source);
  if (cached && Date.now() - cached.fetchedAt < FIELD_CACHE_TTL_MS) return cached.options;
  const url = source === 'letpub'
    ? `${LETPUB_BASE}/index.php?page=journalapp&view=researchfield&fieldtag=all&firstletter=`
    : `${ESHUKAN_BASE}/jtypelist.aspx`;
  const html = await fetchCatalogPage(url);
  const options = source === 'letpub' ? parseLetPubFieldOptions(html) : parseEshukanCategories(html);
  if (options.length > 0) fieldCaches.set(source, { options, fetchedAt: Date.now() });
  return options;
}

/** Test hook: prime the field cache without network access. */
export function primeCatalogFieldCache(source: JournalCatalogSource, options: CatalogFieldOption[]): void {
  fieldCaches.set(source, { options, fetchedAt: Date.now() });
}

// ─── Public operations ───────────────────────────────────────────

export interface CatalogSearchInput {
  source: JournalCatalogSource;
  /** Subject/category name in Chinese, e.g. 社会学 / 社会学大类. */
  field?: string;
  /** Journal-name keyword; LetPub only (e.g. "rural sociology"). */
  keyword?: string;
  /** A–Z filter on journal initial for LetPub field browsing. */
  firstLetter?: string;
  page?: number;
}

export async function searchJournalCatalog(input: CatalogSearchInput): Promise<CatalogSearchResult> {
  const page = Math.max(1, Math.floor(input.page ?? 1));
  const keyword = input.keyword?.trim() ?? '';
  const fieldName = input.field?.trim() ?? '';

  if (input.source === 'letpub') {
    if (!fieldName && !keyword) {
      const options = await loadCatalogFields('letpub');
      return {
        source: 'letpub',
        field: null,
        keyword: '',
        page,
        journals: [],
        fieldCandidates: options.slice(0, 40),
        note: '请提供 field（研究领域中文名，见 fieldCandidates）或 keyword（英文刊名关键词，如 rural sociology）。',
      };
    }
    if (keyword) {
      const url = `${LETPUB_BASE}/index.php?page=journalapp&view=search&searchname=${encodeURIComponent(keyword)}&currentsearchpage=${page}`;
      const list = parseLetPubJournalList(await fetchCatalogPage(url), page);
      return { source: 'letpub', field: null, keyword, page, journals: list.journals, totalHint: list.totalHint };
    }
    const options = await loadCatalogFields('letpub');
    const matched = matchFieldOptions(options, fieldName);
    if (matched.length !== 1) {
      return {
        source: 'letpub',
        field: null,
        keyword: '',
        page,
        journals: [],
        fieldCandidates: matched.length > 0 ? matched : options.slice(0, 40),
        note: matched.length > 1
          ? `领域「${fieldName}」匹配到多个条目，请从 fieldCandidates 中选择后重试。`
          : `领域「${fieldName}」未匹配，请从 fieldCandidates 中选择后重试。`,
      };
    }
    const field = matched[0]!;
    const letter = (input.firstLetter ?? '').trim().toUpperCase();
    const url = `${LETPUB_BASE}/index.php?page=journalapp&view=researchfield&fieldtag=${encodeURIComponent(field.id)}&firstletter=${encodeURIComponent(letter)}&currentsearchpage=${page}`;
    const list = parseLetPubJournalList(await fetchCatalogPage(url), page);
    return { source: 'letpub', field, keyword: '', page, journals: list.journals, totalHint: list.totalHint };
  }

  // eshukan: category browsing (its GET keyword search does not match by name).
  if (!fieldName) {
    const options = await loadCatalogFields('eshukan');
    return {
      source: 'eshukan',
      field: null,
      keyword: '',
      page,
      journals: [],
      fieldCandidates: options.slice(0, 60),
      note: '请提供 field（学科分类中文名，见 fieldCandidates），万维书刊按分类目录组织期刊。',
    };
  }
  const options = await loadCatalogFields('eshukan');
  const matched = matchFieldOptions(options, fieldName);
  if (matched.length !== 1) {
    return {
      source: 'eshukan',
      field: null,
      keyword,
      page,
      journals: [],
      fieldCandidates: matched.length > 0 ? matched : options.slice(0, 60),
      note: matched.length > 1
        ? `分类「${fieldName}」匹配到多个条目，请从 fieldCandidates 中选择后重试。`
        : `分类「${fieldName}」未匹配，请从 fieldCandidates 中选择后重试。`,
    };
  }
  const field = matched[0]!;
  const url = `${ESHUKAN_BASE}/secondchannel.aspx?typeid=${encodeURIComponent(field.id)}&pg=${page}`;
  const list = parseEshukanJournalList(await fetchCatalogPage(url), page);
  return { source: 'eshukan', field, keyword: '', page, journals: list.journals, totalHint: list.totalHint };
}

export async function getJournalCatalogDetail(source: JournalCatalogSource, id: string): Promise<CatalogJournalDetail> {
  const cleanId = id.trim().replace(/^\D*(\d+)\D*$/u, '$1');
  if (!cleanId) throw new JournalCatalogFetchError('catalog_id_invalid');
  if (source === 'letpub') {
    return parseLetPubDetail(await fetchCatalogPage(`${LETPUB_BASE}/index.php?journalid=${cleanId}&page=journalapp&view=detail`), cleanId);
  }
  return parseEshukanDetail(await fetchCatalogPage(`${ESHUKAN_BASE}/displayj.aspx?jid=${cleanId}`), cleanId);
}
