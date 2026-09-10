/**
 * Web page metadata extraction for academic URLs.
 *
 * Fetches a page, parses common citation meta tags, extracts DOI/arXiv IDs,
 * and optionally enriches the result via Crossref. Produces both a structured
 * paper object and a BibTeX entry.
 */

import { getWorkByDoi, type CrossrefMetadata } from './CrossrefClient.js';

export interface WebImportResult {
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  doi?: string;
  arxivId?: string;
  url: string;
  bibtex: string;
  source: 'crossref' | 'meta' | 'url';
}

function extractMeta(html: string, names: string[]): string | undefined {
  for (const name of names) {
    const patterns = [
      new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'i'),
      new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, 'i'),
    ];
    for (const pattern of patterns) {
      const match = html.match(pattern);
      if (match?.[1]) return match[1].trim();
    }
  }
  return undefined;
}

function extractAllMeta(html: string, name: string): string[] {
  const results: string[] = [];
  const patterns = [
    new RegExp(`<meta[^>]+(?:name|property)=["']${name}["'][^>]+content=["']([^"']*)["']`, 'ig'),
    new RegExp(`<meta[^>]+content=["']([^"']*)["'][^>]+(?:name|property)=["']${name}["']`, 'ig'),
  ];
  for (const pattern of patterns) {
    let match: RegExpExecArray | null;
    while ((match = pattern.exec(html)) !== null) {
      if (match[1]) results.push(match[1].trim());
    }
  }
  return [...new Set(results)];
}

function extractDoi(html: string, url: string): string | undefined {
  const fromMeta =
    extractMeta(html, ['citation_doi', 'DC.Identifier', 'doi', 'prism.doi'])
    ?? extractMeta(html, ['og:url']);
  if (fromMeta) {
    const cleaned = fromMeta.replace(/^doi:\s*/i, '').replace(/^https?:\/\/doi\.org\//i, '');
    if (/^10\.\d+\/.+/.test(cleaned)) return cleaned;
  }

  const fromUrl = url.match(/(?:doi\.org\/|doi=)(10\.\d+\/[^&\s]+)/i)?.[1];
  if (fromUrl) return fromUrl;

  return undefined;
}

function extractArxivId(html: string, url: string): string | undefined {
  const fromMeta = extractMeta(html, ['citation_arxiv_id', 'arxiv_id']);
  if (fromMeta) return fromMeta;

  const fromUrl = url.match(/arxiv\.org\/abs\/(\d+\.\d+|[^/]+)/i)?.[1]
    ?? url.match(/arxiv\.org\/pdf\/(\d+\.\d+|[^/]+)/i)?.[1];
  return fromUrl;
}

function formatAuthors(raw: string[]): string[] {
  return raw
    .flatMap((entry) => entry.split(/;\s*|\s+and\s+/i))
    .map((name) => name.trim())
    .filter(Boolean);
}

function normalizeYear(raw?: string): number {
  if (!raw) return 0;
  const match = raw.match(/(\d{4})/);
  return match ? Number(match[1]) : 0;
}

function generateBibtexKey(title: string, year: number, authors: string[]): string {
  const lastName = authors[0]?.split(' ').pop()?.toLowerCase() ?? 'unknown';
  const shortTitle = title
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, '')
    .split(/\s+/)
    .filter((w) => w.length > 3)
    .slice(0, 2)
    .join('');
  return `${lastName}${year}${shortTitle || 'paper'}`.replace(/[^a-z0-9]/g, '');
}

function generateBibtex(entry: WebImportResult): string {
  const key = generateBibtexKey(entry.title, entry.year, entry.authors);
  const lines = [
    `@article{${key},`,
    `  title = {${entry.title}},`,
    `  author = {${entry.authors.join(' and ')}},`,
    `  year = {${entry.year || 'n.d.'}},`,
  ];
  if (entry.venue) lines.push(`  journal = {${entry.venue}},`);
  if (entry.doi) lines.push(`  doi = {${entry.doi}},`);
  if (entry.url) lines.push(`  url = {${entry.url}},`);
  if (entry.abstract) lines.push(`  abstract = {${entry.abstract}},`);
  lines.push('}');
  return lines.join('\n');
}

async function fetchHtml(url: string, timeoutMs = 15000): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(url, {
      headers: {
        'User-Agent': 'Mozilla/5.0 (compatible; MetisWorkbench/1.0; +https://example.com)',
        Accept: 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
      },
      signal: controller.signal,
      redirect: 'follow',
    });

    if (!response.ok) {
      throw new Error(`HTTP ${response.status}: ${response.statusText}`);
    }

    const contentType = response.headers.get('content-type') ?? '';
    if (contentType.includes('application/pdf')) {
      throw new Error('URL points directly to a PDF. Use read_pdf instead.');
    }

    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function metaToResult(html: string, url: string): WebImportResult {
  const title =
    extractMeta(html, ['citation_title', 'DC.Title', 'og:title', 'twitter:title', 'title'])
    ?? '';
  const authors = formatAuthors(extractAllMeta(html, 'citation_author'));
  const year = normalizeYear(
    extractMeta(html, ['citation_date', 'citation_publication_date', 'DC.Date', 'date']),
  );
  const venue =
    extractMeta(html, ['citation_journal_title', 'citation_conference_title', 'DC.Source'])
    ?? '';
  const abstract =
    extractMeta(html, ['citation_abstract', 'DC.Description', 'og:description', 'description'])
    ?? '';
  const doi = extractDoi(html, url);
  const arxivId = extractArxivId(html, url);

  const result: WebImportResult = {
    title,
    authors,
    year,
    venue,
    abstract,
    doi,
    arxivId,
    url,
    bibtex: '',
    source: 'meta',
  };
  result.bibtex = generateBibtex(result);
  return result;
}

function crossrefToResult(metadata: CrossrefMetadata, url: string): WebImportResult {
  const result: WebImportResult = {
    title: metadata.title,
    authors: metadata.authors,
    year: metadata.year,
    venue: metadata.venue,
    abstract: metadata.abstract ?? '',
    doi: metadata.doi,
    url,
    bibtex: '',
    source: 'crossref',
  };
  result.bibtex = generateBibtex(result);
  return result;
}

/**
 * Import bibliographic metadata from a web page URL.
 */
export async function importFromUrl(url: string): Promise<WebImportResult> {
  const html = await fetchHtml(url);
  const metaResult = metaToResult(html, url);

  if (metaResult.doi) {
    try {
      const crossref = await getWorkByDoi(metaResult.doi);
      if (crossref) {
        return crossrefToResult(crossref, url);
      }
    } catch {
      // Fall back to extracted meta tags.
    }
  }

  return metaResult;
}
