/**
 * DOI resolver — turn a DOI into structured paper metadata.
 *
 * Primary source: CrossRef API (https://api.crossref.org/works/{doi}).
 * Fallback: Semantic Scholar API for abstract enrichment.
 */

export interface DoiMetadata {
  doi: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  url?: string;
  arxivId?: string;
  pdfUrl?: string;
  citationCount?: number;
}

const CROSSREF_BASE = 'https://api.crossref.org/works';
const SEMANTIC_SCHOLAR_BASE = 'https://api.semanticscholar.org/graph/v1/paper';

function extractYear(message: Record<string, unknown>): number | undefined {
  const issued = message.issued as { 'date-parts'?: number[][] } | undefined;
  const publishedPrint = message['published-print'] as { 'date-parts'?: number[][] } | undefined;
  const publishedOnline = message['published-online'] as { 'date-parts'?: number[][] } | undefined;
  const year = issued?.['date-parts']?.[0]?.[0]
    ?? publishedPrint?.['date-parts']?.[0]?.[0]
    ?? publishedOnline?.['date-parts']?.[0]?.[0];
  return typeof year === 'number' ? year : undefined;
}

function extractAuthors(message: Record<string, unknown>): string[] {
  const authors = message.author as Array<{ family?: string; given?: string; name?: string }> | undefined;
  if (!Array.isArray(authors)) return [];
  return authors
    .map((a) => {
      if (a.name) return a.name.trim();
      const parts = [a.given, a.family].filter(Boolean);
      return parts.join(' ').trim();
    })
    .filter(Boolean);
}

function extractTitle(message: Record<string, unknown>): string {
  const title = message.title;
  if (Array.isArray(title) && title.length > 0 && typeof title[0] === 'string') return title[0];
  if (typeof title === 'string') return title;
  return '';
}

function extractVenue(message: Record<string, unknown>): string {
  const container = message['container-title'];
  if (Array.isArray(container) && container.length > 0 && typeof container[0] === 'string') return container[0];
  const shortContainer = message['short-container-title'];
  if (Array.isArray(shortContainer) && shortContainer.length > 0 && typeof shortContainer[0] === 'string') return shortContainer[0];
  return '';
}

function extractAbstract(message: Record<string, unknown>): string {
  const abstract = message.abstract;
  if (typeof abstract !== 'string') return '';
  // CrossRef abstracts are sometimes wrapped in jats XML tags; strip basic tags.
  return abstract
    .replace(/<\/?jats:[^>]+>/g, ' ')
    .replace(/<\/?[^>]+>/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function extractUrl(message: Record<string, unknown>): string | undefined {
  const url = message.URL;
  return typeof url === 'string' ? url : undefined;
}

async function fetchCrossRef(doi: string, timeoutMs = 10000): Promise<DoiMetadata | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${CROSSREF_BASE}/${encodeURIComponent(doi)}?mailto=metis-workbench@local`, {
      headers: { Accept: 'application/json' },
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const data = await response.json() as { message?: Record<string, unknown> };
    const message = data.message ?? {};
    const year = extractYear(message);

    return {
      doi: doi.toLowerCase().trim(),
      title: extractTitle(message),
      authors: extractAuthors(message),
      year: year ?? 0,
      venue: extractVenue(message),
      abstract: extractAbstract(message),
      url: extractUrl(message),
    };
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

interface SemanticScholarEnrichment {
  abstract?: string;
  externalIds?: { ArXiv?: string };
  openAccessPdf?: { url?: string };
  citationCount?: number;
}

async function fetchSemanticScholarEnrichment(doi: string, timeoutMs = 10000): Promise<SemanticScholarEnrichment | null> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(
      `${SEMANTIC_SCHOLAR_BASE}/DOI:${encodeURIComponent(doi)}?fields=abstract,externalIds,openAccessPdf,citationCount`,
      { headers: { Accept: 'application/json' }, signal: controller.signal },
    );
    if (!response.ok) return null;

    return await response.json() as SemanticScholarEnrichment;
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Resolve a DOI to structured paper metadata.
 *
 * CrossRef provides authoritative title/authors/year/venue/URL.
 * Semantic Scholar is used to enrich abstract, arXiv ID, open-access PDF URL and citation count.
 */
export async function resolveDoi(doi: string): Promise<DoiMetadata | null> {
  const normalizedDoi = doi.trim().replace(/^doi:\s*/i, '').replace(/^https?:\/\/doi\.org\//i, '');
  if (!normalizedDoi) return null;

  const metadata = await fetchCrossRef(normalizedDoi);
  if (!metadata) return null;

  const enrichment = await fetchSemanticScholarEnrichment(normalizedDoi);
  if (enrichment) {
    if (!metadata.abstract && enrichment.abstract) metadata.abstract = enrichment.abstract;
    if (enrichment.externalIds?.ArXiv) metadata.arxivId = enrichment.externalIds.ArXiv;
    if (enrichment.openAccessPdf?.url) metadata.pdfUrl = enrichment.openAccessPdf.url;
    if (typeof enrichment.citationCount === 'number') metadata.citationCount = enrichment.citationCount;
  }

  return metadata;
}

/**
 * Convert resolved DOI metadata into a plain object suitable for tool output.
 */
export function doiMetadataToPlain(metadata: DoiMetadata): Record<string, unknown> {
  return {
    doi: metadata.doi,
    title: metadata.title,
    authors: metadata.authors,
    year: metadata.year,
    venue: metadata.venue,
    abstract: metadata.abstract,
    url: metadata.url,
    arxivId: metadata.arxivId,
    pdfUrl: metadata.pdfUrl,
    citationCount: metadata.citationCount,
  };
}
