import { describe, expect, it } from 'vitest';
import { formatCitation, type CitationFormat } from '../../src/utils/citations.js';
import { formatAcademicCitation } from '../../engine/writing/CitationTruth.js';
import type { PaperItem } from '../../src/store';

function makePaper(overrides: Partial<PaperItem> = {}): PaperItem {
  return {
    id: 'p1',
    title: 'Test Paper Title',
    authors: ['Alice Smith', 'Bob Jones'],
    year: 2024,
    venue: 'NeurIPS',
    doi: '10.1234/test',
    abstract: 'A test paper.',
    url: 'https://example.com/paper',
    addedAt: Date.now(),
    tags: [],
    notes: [],
    pdfUrl: undefined,
    pdfDownloadStatus: undefined,
    pdfDownloadError: undefined,
    pdfText: undefined,
    citationCount: undefined,
    ...overrides,
  };
}

describe('formatCitation', () => {
  it('formats APA style with initials', () => {
    const citation = formatCitation(makePaper(), 'apa');
    expect(citation).toContain('Smith, A., & Jones, B.');
    expect(citation).toContain('(2024)');
    expect(citation).toContain('Test Paper Title');
    expect(citation).toContain('NeurIPS');
    expect(citation).toContain('https://doi.org/10.1234/test');
  });

  it('formats MLA style', () => {
    const citation = formatCitation(makePaper(), 'mla');
    expect(citation).toContain('Smith, Alice, and Bob Jones.');
    expect(citation).toContain('"Test Paper Title."');
    expect(citation).toContain('NeurIPS, 2024');
    expect(citation).toContain('doi:10.1234/test');
  });

  it('formats Chicago style', () => {
    const citation = formatCitation(makePaper(), 'chicago');
    expect(citation).toContain('Smith, Alice, and Bob Jones.');
    expect(citation).toContain('“Test Paper Title.”');
    expect(citation).toContain('NeurIPS (2024)');
    expect(citation).toContain('https://doi.org/10.1234/test');
  });

  it('formats IEEE style', () => {
    const citation = formatCitation(makePaper(), 'ieee');
    expect(citation).toContain('A. Smith and B. Jones');
    expect(citation).toContain('“Test Paper Title,”');
    expect(citation).toContain('NeurIPS, 2024');
    expect(citation).toContain('doi: 10.1234/test');
  });

  it('falls back to Unknown when no authors are provided', () => {
    const citation = formatCitation(makePaper({ authors: [] }), 'apa');
    expect(citation).toContain('Unknown');
  });

  it('omits venue and doi when not present', () => {
    const paper = makePaper({ venue: undefined, doi: undefined });
    const citation = formatCitation(paper, 'apa');
    expect(citation).not.toContain('NeurIPS');
    expect(citation).not.toContain('doi');
  });

  it('handles three or more authors with et al. in MLA', () => {
    const paper = makePaper({ authors: ['Alice Smith', 'Bob Jones', 'Carol White'] });
    const citation = formatCitation(paper, 'mla');
    expect(citation).toContain('Smith, Alice, et al.');
  });

  it('accepts all supported citation formats', () => {
    const formats: CitationFormat[] = ['apa', 'mla', 'chicago', 'ieee'];
    for (const fmt of formats) {
      expect(typeof formatCitation(makePaper(), fmt)).toBe('string');
    }
  });

  it('offers GB/T 7714 and Vancouver through the UI formatter', () => {
    expect(formatCitation(makePaper(), 'gbt7714')).toContain('[J]');
    expect(formatCitation(makePaper(), 'vancouver')).toContain('doi:10.1234/test');
  });

  it('matches exact golden vectors for APA, Chicago, IEEE, Vancouver and GB/T 7714', () => {
    const input = {
      authors: [
        { family: 'Smith', given: 'John P.' },
        { family: 'Doe', given: 'Jane A.' },
      ],
      year: 2024,
      title: 'Evidence and Policy',
      containerTitle: 'Journal of Research',
      volume: '12',
      issue: '3',
      pages: '45-67',
      doi: '10.1234/example',
      type: 'journal_article' as const,
    };
    expect(formatAcademicCitation(input, 'apa')).toBe('Smith, J. P., & Doe, J. A. (2024). Evidence and Policy. Journal of Research, 12(3), 45–67. https://doi.org/10.1234/example');
    expect(formatAcademicCitation(input, 'chicago')).toBe('Smith, John P., and Jane A. Doe. “Evidence and Policy.” Journal of Research 12, no. 3 (2024): 45–67. https://doi.org/10.1234/example.');
    expect(formatAcademicCitation(input, 'ieee')).toBe('J. P. Smith and J. A. Doe, “Evidence and Policy,” Journal of Research, vol. 12, no. 3, pp. 45–67, 2024, doi: 10.1234/example.');
    expect(formatAcademicCitation(input, 'vancouver')).toBe('Smith JP, Doe JA. Evidence and Policy. Journal of Research. 2024;12(3):45-67. doi:10.1234/example.');
    expect(formatAcademicCitation(input, 'gbt7714')).toBe('SMITH J P, DOE J A. Evidence and Policy[J]. Journal of Research, 2024, 12(3): 45-67. DOI:10.1234/example.');
  });
});
