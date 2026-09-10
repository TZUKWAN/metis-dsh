/**
 * ScenarioLiteratureBridge（2026-08-30 刘总问题 B 修复）
 *
 * 问题：场景工作流里"检索文献"步骤的产物只以自由 Markdown 落会话级 artifacts，
 * 资料页「我的文献」（papers 表）与 sources/paper_project_links 从不被写入，
 * 项目跑完文献库仍是空的。
 *
 * 桥的两道闸：
 *   1. 结构闸：产物里必须真的带 JSON 题录数组（```json 围栏块或裸数组），
 *      元素含非空 title 才进入候选——自由文本产物直接零成本跳过。
 *   2. 真实性闸（防模型凭记忆虚构题录污染文献库）：
 *      - 有 DOI → crossref 轻校验存在性，404 拒收；网络故障无法判定时
 *        收编但计入 unverifiedNetwork 并留日志（不因网络抖动丢真实文献）。
 *      - 无 DOI 但有 URL → 直接收。
 *      - 两者皆无 → 拒收并计数，日志可见。
 *
 * 入库路径复用已验证链路：savePaper（papers 表，幂等 upsert，已存在则跳过
 * 避免覆盖用户笔记/读态）→ linkLibraryPaperToProject（papers+sources+
 * paper_project_links 三写事务，(projectId, paperId) 幂等）。
 */

import { createHash } from 'node:crypto';
import type { PersistenceStore } from '../engine/persistence/PersistenceStore.js';
import type { ResearchRepository } from '../engine/persistence/ResearchRepository.js';

export interface BibliographyEntry {
  title: string;
  authors: string[];
  year: number;
  venue: string;
  doi?: string;
  url?: string;
  arxivId?: string;
}

export interface BibliographyIngestResult {
  /** JSON 题录候选条数（结构闸通过）。 */
  parsed: number;
  /** 新写入 papers 表的条数。 */
  imported: number;
  /** 三写链接成功的条数（含已存在论文的补链）。 */
  linked: number;
  /** 无 DOI 且无 URL，按真实性闸拒收。 */
  rejectedUnverifiable: number;
  /** DOI 经 crossref 确认不存在，拒收。 */
  rejectedDoiNotFound: number;
  /** DOI 校验遇网络故障无法判定，收编但未证实（日志计数）。 */
  unverifiedNetwork: number;
}

export type DoiVerifier = (doi: string) => Promise<'found' | 'not_found' | 'unknown'>;

export type ScenarioLiteratureBridge = (input: {
  projectId: string;
  artifactId: string;
  content: string;
  runId: string;
  stepId?: string;
}) => Promise<BibliographyIngestResult>;

const EMPTY_RESULT: BibliographyIngestResult = {
  parsed: 0,
  imported: 0,
  linked: 0,
  rejectedUnverifiable: 0,
  rejectedDoiNotFound: 0,
  unverifiedNetwork: 0,
};

const MAX_ENTRIES_PER_ARTIFACT = 50;
const DOI_PATTERN = /^10\.\d{4,9}\/\S+$/i;

/** crossref 存在性轻校验：只问"这个 DOI 注册了没有"，不取全量元数据。 */
export const crossrefDoiVerifier: DoiVerifier = async (doi) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 6_000);
  try {
    const response = await fetch(`https://api.crossref.org/works/${encodeURIComponent(doi)}`, {
      signal: controller.signal,
      headers: { 'User-Agent': 'metis-workbench literature bridge (mailto:metis-local@localhost)' },
    });
    if (response.status === 404) return 'not_found';
    return response.ok ? 'found' : 'unknown';
  } catch {
    return 'unknown';
  } finally {
    clearTimeout(timer);
  }
};

function normalizeDoi(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim()
    .replace(/^https?:\/\/(?:dx\.)?doi\.org\//iu, '')
    .replace(/^doi:\s*/iu, '')
    .trim();
  return DOI_PATTERN.test(value) ? value : undefined;
}

function normalizeUrl(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim();
  return /^https?:\/\/\S+$/iu.test(value) ? value.slice(0, 1_000) : undefined;
}

function normalizeArxiv(raw: unknown): string | undefined {
  if (typeof raw !== 'string') return undefined;
  const value = raw.trim().replace(/^arxiv:\s*/iu, '');
  return /^\d{4}\.\d{4,5}(v\d+)?$/u.test(value) || /^[a-z-]+(?:\.[A-Z]{2})?\/\d{7}$/u.test(value)
    ? value
    : undefined;
}

function normalizeAuthors(raw: unknown): string[] {
  if (Array.isArray(raw)) {
    return raw
      .map((item) => {
        if (typeof item === 'string') return item.trim();
        if (item && typeof item === 'object' && !Array.isArray(item)) {
          const name = (item as Record<string, unknown>).name;
          return typeof name === 'string' ? name.trim() : '';
        }
        return '';
      })
      .filter((name) => name.length > 0)
      .slice(0, 50);
  }
  if (typeof raw === 'string') {
    return raw.split(/[,;，、]|\s+and\s+/u).map((name) => name.trim()).filter(Boolean).slice(0, 50);
  }
  return [];
}

function normalizeYear(raw: unknown): number {
  const candidate = typeof raw === 'number' ? raw : typeof raw === 'string' ? Number.parseInt(raw, 10) : NaN;
  return Number.isInteger(candidate) && candidate >= 0 && candidate <= 3000 ? candidate : 0;
}

function normalizeEntry(raw: unknown): BibliographyEntry | null {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return null;
  const record = raw as Record<string, unknown>;
  const title = typeof record.title === 'string' ? record.title.trim() : '';
  if (!title) return null;
  const venue = [record.venue, record.journal, record.container, record.publisher]
    .map((value) => (typeof value === 'string' ? value.trim() : ''))
    .find((value) => value.length > 0) ?? '';
  const doi = normalizeDoi(record.doi ?? record.DOI);
  const url = normalizeUrl(record.url ?? record.link ?? record.pdfUrl);
  const arxivId = normalizeArxiv(record.arxivId ?? record.arxiv_id ?? record.arxiv);
  return {
    title: title.slice(0, 500),
    authors: normalizeAuthors(record.authors ?? record.author),
    year: normalizeYear(record.year ?? record.published ?? record.date),
    venue: venue.slice(0, 300),
    ...(doi ? { doi } : {}),
    ...(url ? { url } : {}),
    ...(arxivId ? { arxivId } : {}),
  };
}

/** 从一个 JSON 文本里收集题录候选：顶层数组，或包一层 {references|papers|bibliography|results|items}。 */
function collectFromJson(text: string, sink: unknown[]): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return;
  }
  if (Array.isArray(parsed)) {
    sink.push(...parsed);
    return;
  }
  if (parsed && typeof parsed === 'object') {
    for (const key of ['references', 'bibliography', 'papers', 'works', 'results', 'items', 'citations']) {
      const nested = (parsed as Record<string, unknown>)[key];
      if (Array.isArray(nested)) sink.push(...nested);
    }
  }
}

/** 裸 JSON 数组的括号配平扫描（字符串感知），只收 `[{` 开头的数组。 */
function extractBalancedArrays(text: string): string[] {
  const spans: string[] = [];
  for (let i = 0; i < text.length; i += 1) {
    if (text[i] !== '[') continue;
    let j = i + 1;
    while (j < text.length && /\s/u.test(text[j]!)) j += 1;
    if (text[j] !== '{') continue;
    let depth = 0;
    let inString = false;
    let escaped = false;
    for (let k = i; k < text.length; k += 1) {
      const ch = text[k]!;
      if (inString) {
        if (escaped) escaped = false;
        else if (ch === '\\') escaped = true;
        else if (ch === '"') inString = false;
        continue;
      }
      if (ch === '"') { inString = true; continue; }
      if (ch === '[') depth += 1;
      else if (ch === ']') {
        depth -= 1;
        if (depth === 0) {
          spans.push(text.slice(i, k + 1));
          i = k;
          break;
        }
      }
    }
  }
  return spans;
}

/**
 * 结构闸：从产物文本提取 JSON 题录数组。先扫 ```json 围栏块，再扫裸平衡数组。
 * 返回经字段归一化、按 (doi|url|title) 去重后的题录，上限 50 条。
 */
export function extractBibliographyEntries(content: string, maxEntries = MAX_ENTRIES_PER_ARTIFACT): BibliographyEntry[] {
  if (!content || !content.includes('{')) return [];
  const rawItems: unknown[] = [];
  for (const match of content.matchAll(/```(?:json)?[^\S\r\n]*\r?\n([\s\S]*?)```/g)) {
    collectFromJson(match[1] ?? '', rawItems);
  }
  if (rawItems.length === 0) {
    for (const span of extractBalancedArrays(content)) {
      collectFromJson(span, rawItems);
      if (rawItems.length > 0) break;
    }
  }
  if (rawItems.length === 0) return [];
  const seen = new Set<string>();
  const entries: BibliographyEntry[] = [];
  for (const raw of rawItems) {
    const entry = normalizeEntry(raw);
    if (!entry) continue;
    const key = (entry.doi ? `doi:${entry.doi.toLowerCase()}` : entry.url ? `url:${entry.url}` : `title:${entry.title.toLowerCase()}`) ;
    if (seen.has(key)) continue;
    seen.add(key);
    entries.push(entry);
    if (entries.length >= maxEntries) break;
  }
  return entries;
}

export function createScenarioLiteratureBridge(deps: {
  store: PersistenceStore;
  researchRepository: ResearchRepository;
  verifyDoi?: DoiVerifier;
  now?: () => number;
}): ScenarioLiteratureBridge {
  const verifyDoi = deps.verifyDoi ?? crossrefDoiVerifier;
  const now = deps.now ?? Date.now;
  return async (input) => {
    const entries = extractBibliographyEntries(input.content);
    if (entries.length === 0) return { ...EMPTY_RESULT };
    const result: BibliographyIngestResult = { ...EMPTY_RESULT, parsed: entries.length };
    const existsStmt = deps.store.raw.prepare('SELECT 1 AS ok FROM papers WHERE id = ?');
    for (const entry of entries) {
      // 真实性闸
      if (entry.doi) {
        const verdict = await verifyDoi(entry.doi);
        if (verdict === 'not_found') {
          result.rejectedDoiNotFound += 1;
          continue;
        }
        if (verdict === 'unknown') result.unverifiedNetwork += 1;
      } else if (!entry.url) {
        result.rejectedUnverifiable += 1;
        continue;
      }
      const paperId = entry.doi
        ? `paper_doi_${createHash('sha256').update(entry.doi.toLowerCase(), 'utf8').digest('hex').slice(0, 32)}`
        : `paper_url_${createHash('sha256').update(entry.url!, 'utf8').digest('hex').slice(0, 32)}`;
      // savePaper 是整行 upsert，会覆盖用户笔记/读态——已存在的论文只补链不重写。
      if (!existsStmt.get(paperId)) {
        deps.store.savePaper({
          id: paperId,
          title: entry.title,
          authors: entry.authors,
          year: entry.year,
          venue: entry.venue,
          abstract: '',
          ...(entry.doi ? { doi: entry.doi } : {}),
          ...(entry.arxivId ? { arxivId: entry.arxivId } : {}),
          ...(entry.url ? { pdfUrl: entry.url } : {}),
          tags: ['scenario-imported'],
          notes: '',
          readStatus: 'unread',
          rating: 0,
          addedAt: now(),
          projectId: input.projectId,
        });
        result.imported += 1;
      }
      const linked = deps.researchRepository.linkLibraryPaperToProject({
        paperId,
        projectId: input.projectId,
        title: entry.title,
        authors: entry.authors,
        year: entry.year,
        venue: entry.venue,
        ...(entry.doi ? { doi: entry.doi } : {}),
        ...(entry.arxivId ? { arxivId: entry.arxivId } : {}),
      });
      if (linked) {
        result.linked += 1;
      } else {
        console.warn(`[LiteratureBridge] link failed for paper=${paperId} project=${input.projectId} (run=${input.runId})`);
      }
    }
    console.log(
      `[LiteratureBridge] run=${input.runId} step=${input.stepId ?? '-'} artifact=${input.artifactId.slice(0, 40)} `
      + `parsed=${result.parsed} imported=${result.imported} linked=${result.linked} `
      + `rejected(unverifiable=${result.rejectedUnverifiable}, doi404=${result.rejectedDoiNotFound}) unverifiedNetwork=${result.unverifiedNetwork}`,
    );
    return result;
  };
}
