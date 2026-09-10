/**
 * arXiv resolver — turn an arXiv ID into structured paper metadata.
 *
 * Uses the arXiv Atom API: https://export.arxiv.org/api/query?id_list={id}
 */

export interface ArxivMetadata {
  arxivId: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  url: string;
  pdfUrl: string;
  doi?: string;
  primaryCategory?: string;
  categories?: string[];
}

const ARXIV_API_BASE = 'https://export.arxiv.org/api/query';

function normalizeArxivId(input: string): string | null {
  const trimmed = input.trim();
  if (!trimmed) return null;
  // Match arXiv IDs: 1234.5678, arXiv:1234.5678, https://arxiv.org/abs/1234.5678
  const match = trimmed.match(/(?:arxiv\.org\/(?:abs|pdf)\/)?(?:ar[xX]iv:)?([\d.]+(?:v\d+)?)/);
  return match?.[1] ?? null;
}

function extractText(xml: string, tag: string): string {
  const regex = new RegExp(`<${tag}[^>]*>([\\s\\S]*?)<\\/${tag}>`, 'i');
  const match = xml.match(regex);
  return match?.[1]?.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim() ?? '';
}

function extractFirst(xml: string, regex: RegExp): string | undefined {
  const match = xml.match(regex);
  return match?.[1];
}

function parseAtom(xml: string): ArxivMetadata | null {
  const entryMatch = xml.match(/<entry[^>]*>([\s\S]*?)<\/entry>/i);
  if (!entryMatch) return null;
  const entry = entryMatch[1]!;

  const id = extractFirst(entry, /<id>\s*https:\/\/arxiv.org\/abs\/([^<]+)<\/id>/i)
    ?? extractFirst(entry, /<arxiv:doi>([^<]+)<\/arxiv:doi>/i)
    ?? '';
  const arxivId = id.replace(/v\d+$/i, '');
  if (!arxivId) return null;

  const title = extractText(entry, 'title');
  const summary = extractText(entry, 'summary');

  const authors: string[] = [];
  const authorRegex = /<author[^>]*>[\s\S]*?<name>([^<]+)<\/name>[\s\S]*?<\/author>/gi;
  let authorMatch: RegExpExecArray | null;
  while ((authorMatch = authorRegex.exec(entry)) !== null) {
    authors.push(authorMatch[1]!.trim());
  }

  const published = extractText(entry, 'published');
  const year = published ? new Date(published).getFullYear() : 0;

  const journalRef = extractText(entry, 'arxiv:journal_ref');
  const comment = extractText(entry, 'arxiv:comment');
  const venue = journalRef || comment || '';

  const doi = extractText(entry, 'arxiv:doi') || undefined;

  const primaryCategory = extractFirst(entry, /<arxiv:primary_category[^>]+term="([^"]+)"/i);
  const categories: string[] = [];
  const categoryRegex = /<category[^>]+term="([^"]+)"/gi;
  let categoryMatch: RegExpExecArray | null;
  while ((categoryMatch = categoryRegex.exec(entry)) !== null) {
    categories.push(categoryMatch[1]!);
  }

  const pdfUrl = `https://arxiv.org/pdf/${arxivId}.pdf`;
  const url = `https://arxiv.org/abs/${arxivId}`;

  return {
    arxivId,
    title: title || arxivId,
    authors,
    year,
    venue,
    abstract: summary,
    url,
    pdfUrl,
    doi,
    primaryCategory: primaryCategory ?? categories[0],
    categories,
  };
}

export async function resolveArxiv(input: string, timeoutMs = 15000): Promise<ArxivMetadata | null> {
  const arxivId = normalizeArxivId(input);
  if (!arxivId) return null;

  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);

  try {
    const response = await fetch(`${ARXIV_API_BASE}?id_list=${encodeURIComponent(arxivId)}&max_results=1`, {
      signal: controller.signal,
    });
    if (!response.ok) return null;

    const xml = await response.text();
    return parseAtom(xml);
  } catch {
    return null;
  } finally {
    clearTimeout(timeoutId);
  }
}

export function arxivMetadataToPlain(metadata: ArxivMetadata): Record<string, unknown> {
  return {
    arxivId: metadata.arxivId,
    title: metadata.title,
    authors: metadata.authors,
    year: metadata.year,
    venue: metadata.venue,
    abstract: metadata.abstract,
    url: metadata.url,
    pdfUrl: metadata.pdfUrl,
    doi: metadata.doi,
    primaryCategory: metadata.primaryCategory,
    categories: metadata.categories,
  };
}
