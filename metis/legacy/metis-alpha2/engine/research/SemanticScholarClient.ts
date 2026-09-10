/**
 * Semantic Scholar API client.
 *
 * Wraps the public Semantic Scholar Graph API for searching papers and
 * fetching paper details. No API key is required for basic usage, but a
 * key improves rate limits when available.
 *
 * API documentation: https://api.semanticscholar.org/api-docs/graph
 */

export interface SemanticScholarAuthor {
  authorId?: string;
  name: string;
}

export interface SemanticScholarExternalIds {
  DOI?: string;
  ArXiv?: string;
  PubMed?: string;
  PubMedCentral?: string;
  DBLP?: string;
  MAG?: string;
  ACL?: string;
  CorpusId?: string;
}

export interface SemanticScholarPaper {
  paperId: string;
  url?: string;
  title: string;
  abstract?: string;
  venue?: string;
  year?: number;
  referenceCount?: number;
  citationCount?: number;
  influentialCitationCount?: number;
  isOpenAccess?: boolean;
  openAccessPdf?: { url?: string; status?: string } | null;
  authors?: SemanticScholarAuthor[];
  externalIds?: SemanticScholarExternalIds;
}

export interface SemanticScholarSearchResult {
  total: number;
  offset: number;
  next?: number;
  data: SemanticScholarPaper[];
}

export interface SearchPapersOptions {
  query: string;
  limit?: number;
  offset?: number;
  fields?: string;
  apiKey?: string;
}

export interface GetPaperOptions {
  paperId: string;
  fields?: string;
  apiKey?: string;
}

const DEFAULT_FIELDS = [
  'paperId',
  'title',
  'abstract',
  'year',
  'venue',
  'authors',
  'externalIds',
  'url',
  'citationCount',
  'referenceCount',
  'openAccessPdf',
].join(',');

const BASE_URL = 'https://api.semanticscholar.org/graph/v1';

function buildHeaders(apiKey?: string): Record<string, string> {
  const headers: Record<string, string> = {
    Accept: 'application/json',
  };
  if (apiKey) {
    headers['x-api-key'] = apiKey;
  }
  return headers;
}

async function handleResponse<T>(response: Response): Promise<T> {
  if (!response.ok) {
    const body = await response.text().catch(() => '');
    throw new Error(`Semantic Scholar API error ${response.status}: ${body || response.statusText}`);
  }
  return response.json() as Promise<T>;
}

/**
 * Search papers by free-text query.
 */
export async function searchPapers(options: SearchPapersOptions): Promise<SemanticScholarSearchResult> {
  const { query, limit = 10, offset = 0, fields = DEFAULT_FIELDS, apiKey } = options;

  const url = new URL(`${BASE_URL}/paper/search`);
  url.searchParams.set('query', query);
  url.searchParams.set('fields', fields);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(apiKey),
  });

  const result = await handleResponse<SemanticScholarSearchResult>(response);
  return {
    total: result.total ?? 0,
    offset: result.offset ?? offset,
    next: result.next,
    data: result.data ?? [],
  };
}

/**
 * Fetch a single paper by its Semantic Scholar paper ID.
 */
export async function getPaperById(options: GetPaperOptions): Promise<SemanticScholarPaper | null> {
  const { paperId, fields = DEFAULT_FIELDS, apiKey } = options;

  const url = new URL(`${BASE_URL}/paper/${encodeURIComponent(paperId)}`);
  url.searchParams.set('fields', fields);

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(apiKey),
  });

  if (response.status === 404) {
    return null;
  }

  return handleResponse<SemanticScholarPaper>(response);
}

/**
 * Convert a Semantic Scholar paper into a generic plain object suitable
 * for tool output or UI import.
 */
export function paperToPlain(paper: SemanticScholarPaper): Record<string, unknown> {
  return {
    paperId: paper.paperId,
    title: paper.title,
    authors: (paper.authors ?? []).map((a) => a.name),
    year: paper.year ?? 0,
    venue: paper.venue ?? '',
    abstract: paper.abstract ?? '',
    doi: paper.externalIds?.DOI,
    arxivId: paper.externalIds?.ArXiv,
    url: paper.url,
    citationCount: paper.citationCount ?? 0,
    referenceCount: paper.referenceCount ?? 0,
    openAccessPdf: paper.openAccessPdf?.url,
  };
}

// ─── Citations / References ───────────────────────────────────

export interface CitationEdge {
  paperId?: string;
  title?: string;
  authors?: SemanticScholarAuthor[];
  year?: number;
  venue?: string;
  citationCount?: number;
  externalIds?: SemanticScholarExternalIds;
  url?: string;
  openAccessPdf?: { url?: string; status?: string } | null;
}

export interface CitationListResult {
  offset: number;
  next?: number;
  data: Array<{ citingPaper?: CitationEdge; citedPaper?: CitationEdge }>;
}

export interface PaperRecommendationsOptions {
  paperId: string;
  type: 'citations' | 'references';
  limit?: number;
  offset?: number;
  apiKey?: string;
}

const CITATION_FIELDS = ['paperId', 'title', 'authors', 'year', 'venue', 'externalIds', 'url', 'openAccessPdf'].join(',');

export async function getPaperRecommendations(options: PaperRecommendationsOptions): Promise<CitationListResult> {
  const { paperId, type, limit = 10, offset = 0, apiKey } = options;

  const url = new URL(`${BASE_URL}/paper/${encodeURIComponent(paperId)}/${type}`);
  url.searchParams.set('fields', CITATION_FIELDS);
  url.searchParams.set('limit', String(limit));
  url.searchParams.set('offset', String(offset));

  const response = await fetch(url.toString(), {
    method: 'GET',
    headers: buildHeaders(apiKey),
  });

  const result = await handleResponse<CitationListResult>(response);
  return {
    offset: result.offset ?? offset,
    next: result.next,
    data: result.data ?? [],
  };
}

export function recommendationToPlain(edge: { citingPaper?: CitationEdge; citedPaper?: CitationEdge }): Record<string, unknown> | null {
  const paper = edge.citingPaper ?? edge.citedPaper;
  if (!paper) return null;
  return {
    paperId: paper.paperId,
    title: paper.title ?? 'Untitled',
    authors: (paper.authors ?? []).map((a) => a.name),
    year: paper.year ?? 0,
    venue: paper.venue ?? '',
    doi: paper.externalIds?.DOI,
    arxivId: paper.externalIds?.ArXiv,
    url: paper.url,
    openAccessPdf: paper.openAccessPdf?.url,
    relation: edge.citingPaper ? 'cited by' : 'references',
  };
}
