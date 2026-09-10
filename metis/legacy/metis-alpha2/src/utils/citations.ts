/**
 * Citation formatters — generate APA, MLA, Chicago, and IEEE style citations.
 */

import { formatAcademicCitation, type CitationAuthor } from '../../engine/writing/CitationTruth.js';

export type CitationFormat = 'apa' | 'mla' | 'chicago' | 'ieee' | 'gbt7714' | 'vancouver';

export interface CitationPaperInput {
  authors: string[];
  title: string;
  venue: string;
  year: number;
  doi?: string;
  volume?: string;
  issue?: string;
  pages?: string;
  publisher?: string;
  url?: string;
  publicationType?: 'journal_article' | 'book' | 'chapter' | 'thesis' | 'report' | 'web';
}

function toStructuredAuthor(name: string): CitationAuthor {
  const trimmed = name.trim();
  if (trimmed.includes(',')) {
    const [family = '', given = ''] = trimmed.split(',', 2);
    return { family: family.trim(), given: given.trim() };
  }
  const parts = trimmed.split(/\s+/u).filter(Boolean);
  if (parts.length <= 1) return { family: trimmed || 'Unknown', given: '' };
  const family = parts.pop() ?? trimmed;
  return { family, given: parts.join(' ') };
}

function formatAuthorsMla(authors: string[]): string {
  if (authors.length === 0) return 'Unknown';
  const first = authors[0]!;
  const parts = first.trim().split(/\s+/);
  const last = parts.pop() ?? first;
  const rest = parts.join(' ');
  if (authors.length === 1) return `${last}, ${rest}`.trim();
  if (authors.length === 2) return `${last}, ${rest}, and ${authors[1]}`;
  return `${last}, ${rest}, et al.`;
}

export function formatCitation(paper: CitationPaperInput, format: CitationFormat): string {
  const authors = paper.authors;
  const title = paper.title;
  const venue = paper.venue;
  const year = paper.year;
  const doi = paper.doi;
  if (format !== 'mla') {
    return formatAcademicCitation({
      authors: authors.length > 0 ? authors.map(toStructuredAuthor) : [{ family: 'Unknown', given: '' }],
      year,
      title,
      containerTitle: venue,
      volume: paper.volume,
      issue: paper.issue,
      pages: paper.pages,
      publisher: paper.publisher,
      doi,
      url: paper.url,
      type: paper.publicationType ?? 'journal_article',
    }, format);
  }
  const authorPart = formatAuthorsMla(authors);
  const venuePart = venue ? ` ${venue}` : '';
  const doiPart = doi ? `, doi:${doi}` : '';
  return `${authorPart}. "${title}."${venuePart}, ${year}${doiPart}.`;
}
