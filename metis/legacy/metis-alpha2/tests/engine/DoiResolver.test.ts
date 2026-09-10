/**
 * Tests for DoiResolver.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveDoi, doiMetadataToPlain } from '../../engine/research/DoiResolver.js';

describe('DoiResolver', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(response: unknown, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  it('resolves a DOI to metadata', async () => {
    mockFetch({
      message: {
        title: ['The Anatomy of a Large-Scale Search Engine'],
        author: [{ given: 'S.', family: 'Brin' }, { given: 'L.', family: 'Page' }],
        issued: { 'date-parts': [[1998]] },
        'container-title': ['Computer Networks and ISDN Systems'],
        abstract: 'This paper describes Google.',
        URL: 'http://example.com/paper',
        DOI: '10.1145/276675.276685',
      },
    });

    const result = await resolveDoi('10.1145/276675.276685');

    expect(result).not.toBeNull();
    expect(result?.title).toBe('The Anatomy of a Large-Scale Search Engine');
    expect(result?.authors).toEqual(['S. Brin', 'L. Page']);
    expect(result?.year).toBe(1998);
    expect(result?.venue).toBe('Computer Networks and ISDN Systems');
    expect(result?.doi).toBe('10.1145/276675.276685');
  });

  it('normalizes DOI prefixes', async () => {
    mockFetch({
      message: {
        title: ['Sample'],
        author: [],
        issued: { 'date-parts': [[2020]] },
        'container-title': [],
      },
    });

    await resolveDoi('https://doi.org/10.1234/sample');

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(decodeURIComponent(url)).toContain('/works/10.1234/sample');
  });

  it('enriches abstract from Semantic Scholar when CrossRef lacks it', async () => {
    mockFetch({
      message: {
        title: ['Sample Paper'],
        author: [{ name: 'Alice Author' }],
        issued: { 'date-parts': [[2021]] },
        'container-title': ['Journal'],
      },
    });
    mockFetch({
      abstract: 'Semantic Scholar abstract.',
      externalIds: {},
    });

    const result = await resolveDoi('10.1234/sample');

    expect(result?.abstract).toBe('Semantic Scholar abstract.');
  });

  it('enriches pdfUrl, arxivId and citationCount from Semantic Scholar', async () => {
    mockFetch({
      message: {
        title: ['Sample Paper'],
        author: [{ name: 'Alice Author' }],
        issued: { 'date-parts': [[2021]] },
        'container-title': ['Journal'],
      },
    });
    mockFetch({
      abstract: '',
      externalIds: { ArXiv: '2101.00001' },
      openAccessPdf: { url: 'https://pdf.example.com/paper.pdf' },
      citationCount: 42,
    });

    const result = await resolveDoi('10.1234/sample');

    expect(result?.arxivId).toBe('2101.00001');
    expect(result?.pdfUrl).toBe('https://pdf.example.com/paper.pdf');
    expect(result?.citationCount).toBe(42);
  });

  it('returns null when CrossRef returns 404', async () => {
    mockFetch({ status: 'error' }, 404);

    const result = await resolveDoi('10.0000/missing');

    expect(result).toBeNull();
  });

  it('returns null for empty DOI', async () => {
    const result = await resolveDoi('   ');
    expect(result).toBeNull();
  });

  it('doiMetadataToPlain returns a plain object', () => {
    const metadata = {
      doi: '10.1234/sample',
      title: 'Sample',
      authors: ['Alice'],
      year: 2021,
      venue: 'Journal',
      abstract: 'Abstract',
      url: 'http://example.com',
    };

    const plain = doiMetadataToPlain(metadata);

    expect(plain).toEqual({
      doi: '10.1234/sample',
      title: 'Sample',
      authors: ['Alice'],
      year: 2021,
      venue: 'Journal',
      abstract: 'Abstract',
      url: 'http://example.com',
      arxivId: undefined,
    });
  });
});
