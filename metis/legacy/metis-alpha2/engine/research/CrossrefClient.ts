/**
 * Crossref API client.
 *
 * Wraps the public Crossref REST API for DOI existence checks and metadata
 * retrieval. Crossref is the authoritative source for DOI registration
 * records, making it ideal for citation verification.
 *
 * API documentation: https://api.crossref.org/swagger-ui/index.html
 */

export interface CrossrefAuthor {
  given?: string;
  family?: string;
  name?: string;
  sequence?: string;
}

export interface CrossrefUpdate {
  updated?: { 'date-parts'?: number[][]; 'date-time'?: string; timestamp?: number };
  DOI?: string;
  type?: string;
  source?: string;
  label?: string;
  'record-id'?: number;
}

export interface CrossrefWork {
  DOI: string;
  title?: string[];
  subtitle?: string[];
  author?: CrossrefAuthor[];
  'container-title'?: string[];
  'short-container-title'?: string[];
  'published-print'?: { 'date-parts'?: number[][] };
  'published-online'?: { 'date-parts'?: number[][] };
  issued?: { 'date-parts'?: number[][] };
  created?: { 'date-parts'?: number[][] };
  URL?: string;
  type?: string;
  publisher?: string;
  subject?: string[];
  abstract?: string;
  'is-referenced-by-count'?: number;
  'references-count'?: number;
  'update-to'?: CrossrefUpdate[];
}

export interface CrossrefWorkMessage {
  status: string;
  'message-type'?: string;
  'message-version'?: string;
  message: CrossrefWork;
}

export interface CrossrefSearchResult {
  status: string;
  'message-type'?: string;
  'message-version'?: string;
  message: {
    'items-per-page'?: number;
    query?: Record<string, unknown>;
    'total-results'?: number;
    'next-cursor'?: string;
    items?: CrossrefWork[];
  };
}

export interface CrossrefMetadata {
  doi: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  url?: string;
  type?: string;
  publisher?: string;
  abstract?: string;
  subject?: string[];
  referencedByCount?: number;
  referencesCount?: number;
}

const BASE_URL = 'https://api.crossref.org/works';
const DEFAULT_TIMEOUT_MS = 10000;

function normalizeDoi(input: string): string | null {
  const cleaned = input.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/doi\.org\//i, '');
  if (!cleaned) return null;
  return cleaned.toLowerCase();
}

function extractYear(work: CrossrefWork): number {
  const sources = [
    work.issued?.['date-parts']?.[0]?.[0],
    work['published-print']?.['date-parts']?.[0]?.[0],
    work['published-online']?.['date-parts']?.[0]?.[0],
    work.created?.['date-parts']?.[0]?.[0],
  ];
  for (const year of sources) {
    if (typeof year === 'number') return year;
  }
  return 0;
}

function extractTitle(work: CrossrefWork): string {
  if (Array.isArray(work.title) && work.title.length > 0 && typeof work.title[0] === 'string') {
    return work.title[0];
  }
  return '';
}

function extractAuthors(work: CrossrefWork): string[] {
  if (!Array.isArray(work.author)) return [];
  return work.author
    .map((a) => {
      if (a.name) return a.name.trim();
      const parts = [a.given, a.family].filter((p): p is string => typeof p === 'string' && p.length > 0);
      return parts.join(' ').trim();
    })
    .filter(Boolean);
}

function extractVenue(work: CrossrefWork): string {
  if (Array.isArray(work['container-title']) && work['container-title'].length > 0) {
    return work['container-title'][0]!;
  }
  if (Array.isArray(work['short-container-title']) && work['short-container-title'].length > 0) {
    return work['short-container-title'][0]!;
  }
  return '';
}

function extractAbstract(work: CrossrefWork): string | undefined {
  if (typeof work.abstract !== 'string') return undefined;
  // Crossref abstracts may contain JATS XML tags; strip them lightly.
  return work.abstract
    .replace(/<\/?jats:[^>]+>/gi, ' ')
    .replace(/<\/?[^>]+>/gi, ' ')
    .replace(/\s+/g, ' ')
    .replace(/\s+([.,;:!?)])/g, '$1')
    .trim();
}

function workToMetadata(work: CrossrefWork): CrossrefMetadata {
  return {
    doi: work.DOI.toLowerCase().trim(),
    title: extractTitle(work) || work.DOI,
    authors: extractAuthors(work),
    year: extractYear(work),
    venue: extractVenue(work),
    url: work.URL,
    type: work.type,
    publisher: work.publisher,
    abstract: extractAbstract(work),
    subject: work.subject,
    referencedByCount: work['is-referenced-by-count'],
    referencesCount: work['references-count'],
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
 * Check whether a DOI exists in Crossref.
 *
 * Returns true if Crossref returns a 200 with a valid work record.
 */
export async function exists(doi: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<boolean> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return false;

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/${encodeURIComponent(normalized)}?mailto=metis-workbench@local`, timeoutMs);
    return response.ok;
  } catch {
    return false;
  }
}

/**
 * Fetch the raw Crossref work object for a DOI.
 */
export async function getRawWorkByDoi(doi: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CrossrefWork | null> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/${encodeURIComponent(normalized)}?mailto=metis-workbench@local`, timeoutMs);
    if (!response.ok) return null;

    const data = (await response.json()) as CrossrefWorkMessage;
    const work = data?.message;
    if (!work || !work.DOI) return null;

    return work;
  } catch {
    return null;
  }
}

/**
 * Resolve a DOI to structured metadata via Crossref.
 *
 * Returns null if the DOI is invalid or Crossref returns an error.
 */
export async function getWorkByDoi(doi: string, timeoutMs = DEFAULT_TIMEOUT_MS): Promise<CrossrefMetadata | null> {
  const normalized = normalizeDoi(doi);
  if (!normalized) return null;

  try {
    const response = await fetchWithTimeout(`${BASE_URL}/${encodeURIComponent(normalized)}?mailto=metis-workbench@local`, timeoutMs);
    if (!response.ok) return null;

    const data = (await response.json()) as CrossrefWorkMessage;
    const work = data?.message;
    if (!work || !work.DOI) return null;

    return workToMetadata(work);
  } catch {
    return null;
  }
}

export interface SearchWorksOptions {
  query: string;
  limit?: number;
  offset?: number;
  timeoutMs?: number;
}

/**
 * Search Crossref works by free-text query.
 *
 * Useful as a fallback when only a title fragment is available.
 */
export async function searchWorks(options: SearchWorksOptions): Promise<{ total: number; works: CrossrefMetadata[]; nextOffset?: number }> {
  const { query, limit = 10, offset = 0, timeoutMs = DEFAULT_TIMEOUT_MS } = options;

  const url = new URL(BASE_URL);
  url.searchParams.set('query', query);
  url.searchParams.set('rows', String(limit));
  url.searchParams.set('offset', String(offset));
  url.searchParams.set('mailto', 'metis-workbench@local');

  try {
    const response = await fetchWithTimeout(url.toString(), timeoutMs);
    if (!response.ok) {
      return { total: 0, works: [] };
    }

    const data = (await response.json()) as CrossrefSearchResult;
    const items = data?.message?.items ?? [];
    const total = data?.message?.['total-results'] ?? 0;

    return {
      total,
      works: items.filter((w) => w.DOI).map(workToMetadata),
      nextOffset: items.length === limit ? offset + limit : undefined,
    };
  } catch {
    return { total: 0, works: [] };
  }
}

/**
 * Convert Crossref metadata into a plain object suitable for tool output.
 */
export function metadataToPlain(metadata: CrossrefMetadata): Record<string, unknown> {
  return {
    doi: metadata.doi,
    title: metadata.title,
    authors: metadata.authors,
    year: metadata.year,
    venue: metadata.venue,
    url: metadata.url,
    type: metadata.type,
    publisher: metadata.publisher,
    abstract: metadata.abstract,
    subject: metadata.subject,
    referencedByCount: metadata.referencedByCount,
    referencesCount: metadata.referencesCount,
  };
}
