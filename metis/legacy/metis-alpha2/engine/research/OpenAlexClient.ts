/**
 * OpenAlex API client.
 *
 * Wraps the public OpenAlex API for DOI existence checks and metadata
 * retrieval. OpenAlex provides open bibliographic data and is useful as a
 * second source alongside Crossref and Semantic Scholar for citation
 * verification.
 *
 * API documentation: https://docs.openalex.org/
 */

export interface OpenAlexAuthor {
  id?: string;
  display_name?: string;
  orcid?: string;
}

export interface OpenAlexAuthorship {
  author?: OpenAlexAuthor;
  raw_author_name?: string;
  institutions?: Array<{ display_name?: string }>;
  author_position?: string;
}

export interface OpenAlexSource {
  id?: string;
  display_name?: string;
  type?: string;
  issn_l?: string;
  issn?: string[];
}

export interface OpenAlexLocation {
  is_oa?: boolean;
  landing_page_url?: string;
  pdf_url?: string;
  source?: OpenAlexSource;
  license?: string | null;
  version?: string | null;
}

export interface OpenAlexWork {
  id: string;
  doi?: string;
  title?: string;
  authorships?: OpenAlexAuthorship[];
  publication_year?: number;
  publication_date?: string;
  primary_location?: OpenAlexLocation;
  locations?: OpenAlexLocation[];
  type?: string;
  type_crossref?: string;
  is_retracted?: boolean;
  biblio?: {
    volume?: string;
    issue?: string;
    first_page?: string;
    last_page?: string;
  };
  cited_by_count?: number;
  concepts?: Array<{ display_name: string; score?: number }>;
  abstract_inverted_index?: Record<string, number[]>;
  open_access?: { is_oa?: boolean; oa_status?: string; oa_url?: string };
}

export interface OpenAlexSearchResult {
  meta?: {
    count?: number;
    per_page?: number;
    page?: number;
    next_cursor?: string;
  };
  results?: OpenAlexWork[];
}

export interface OpenAlexMetadata {
  id: string;
  doi?: string;
  title: string;
  authors: string[];
  year: number;
  venue?: string;
  url?: string;
  pdfUrl?: string;
  type?: string;
  isOpenAccess?: boolean;
  citedByCount?: number;
  abstract?: string;
  concepts?: string[];
}

const BASE_URL = 'https://api.openalex.org/works';
const DEFAULT_TIMEOUT_MS = 10000;

function normalizeDoi(input: string): string | null {
  const cleaned = input.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/doi\.org\//i, '');
  if (!cleaned) return null;
  return cleaned.toLowerCase();
}

function extractAuthors(work: OpenAlexWork): string[] {
  if (!Array.isArray(work.authorships)) return [];
  return work.authorships
    .map((a) => a.author?.display_name || a.raw_author_name)
    .filter((name): name is string => typeof name === 'string' && name.length > 0);
}

function extractVenue(work: OpenAlexWork): string | undefined {
  const source = work.primary_location?.source;
  if (source?.display_name) return source.display_name;
  for (const location of work.locations ?? []) {
    if (location.source?.display_name) return location.source.display_name;
  }
  return undefined;
}

function extractUrl(work: OpenAlexWork): string | undefined {
  const landing = work.primary_location?.landing_page_url;
  if (landing) return landing;
  const doi = work.doi;
  if (doi) return `https://doi.org/${doi}`;
  return work.id;
}

function extractPdfUrl(work: OpenAlexWork): string | undefined {
  return work.primary_location?.pdf_url ?? work.open_access?.oa_url ?? undefined;
}

function reconstructAbstract(invertedIndex: Record<string, number[]> | undefined): string | undefined {
  if (!invertedIndex || Object.keys(invertedIndex).length === 0) return undefined;

  const tokens: { position: number; word: string }[] = [];
  for (const [word, positions] of Object.entries(invertedIndex)) {
    if (!Array.isArray(positions)) continue;
    for (const position of positions) {
      tokens.push({ position, word });
    }
  }

  tokens.sort((a, b) => a.position - b.position);
  return tokens.map((t) => t.word).join(' ');
}

function workToMetadata(work: OpenAlexWork): OpenAlexMetadata {
  return {
    id: work.id,
    doi: work.doi ? (normalizeDoi(work.doi) ?? undefined) : undefined,
    title: work.title || work.id,
    authors: extractAuthors(work),
    year: work.publication_year ?? 0,
    venue: extractVenue(work),
    url: extractUrl(work),
    pdfUrl: extractPdfUrl(work),
    type: work.type,
    isOpenAccess: work.open_access?.is_oa,
    citedByCount: work.cited_by_count,
    abstract: reconstructAbstract(work.abstract_inverted_index),
    concepts: work.concepts?.map((c) => c.display_name),
  };
}

async function fetchWithTimeout(url: string, timeoutMs: number): Promise<Response> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check whether a DOI exists in OpenAlex.
 */
export async function exists(doi: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return false;

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/doi:${encodeURIComponent(normalized)}?mailto=metis-workbench@local`, timeoutMs);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the raw OpenAlex work object for a DOI.
 */
export async function getRawWorkByDoi(doi: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<OpenAlexWork | null> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/doi:${encodeURIComponent(normalized)}?mailto=metis-workbench@local`, timeoutMs);
    if (!response.ok) return null;

    const work = (await response.json()) as OpenAlexWork;
    if (!work?.id) return null;

    return work;
  } catch {
    return null;
  }
}

/**
 * Resolve a DOI to structured metadata via OpenAlex.
 */
export async function getWorkByDoi(doi: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<OpenAlexMetadata | null> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/doi:${encodeURIComponent(normalized)}?mailto=metis-workbench@local`, timeoutMs);
    if (!response.ok) return null;

    const work = (await response.json()) as OpenAlexWork;
    if (!work?.id) return null;

    return workToMetadata(work);
  } catch {
    return null;
  }
}

export interface SearchWorksOptions {
  query: string;
  limit?: number;
  cursor?: string;
  timeoutMs?: number;
}

/**
 * Search OpenAlex works by free-text query.
 */
export async function searchWorks(options: SearchWorksOptions): Promise<{ total: number; works: OpenAlexMetadata[]; nextCursor?: string }> {
  const { query, limit = 10, cursor, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const url = new URL(BASE_URL);
  url.searchParams.set('search', query);
  url.searchParams.set('per-page', String(limit));
  url.searchParams.set('mailto', 'metis-workbench@local');
  if (cursor) {
    url.searchParams.set('cursor', cursor);
  }

  try {
    const response = await fetchWithTimeout(url.toString(), timeoutMs);
    if (!response.ok) {
      return { total: 0, works: [] };
    }

    const data = (await response.json()) as OpenAlexSearchResult;
    const results = data?.results ?? [];
    const total = data?.meta?.count ?? 0;

    return {
      total,
      works: results.map(workToMetadata),
      nextCursor: data?.meta?.next_cursor,
    };
  } catch {
    return { total: 0, works: [] };
  }
}

/**
 * Convert OpenAlex metadata into a plain object suitable for tool output.
 */
export function metadataToPlain(metadata: OpenAlexMetadata): Record<string, unknown> {
  return {
    id: metadata.id,
    doi: metadata.doi,
    title: metadata.title,
    authors: metadata.authors,
    year: metadata.year,
    venue: metadata.venue,
    url: metadata.url,
    pdfUrl: metadata.pdfUrl,
    type: metadata.type,
    isOpenAccess: metadata.isOpenAccess,
    citedByCount: metadata.citedByCount,
    abstract: metadata.abstract,
    concepts: metadata.concepts,
  };
}
