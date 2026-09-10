/**
 * Tests for OpenAlexClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  exists,
  getWorkByDoi,
  searchWorks,
  metadataToPlain,
  type OpenAlexWork,
} from '../../engine/research/OpenAlexClient.js';

describe('OpenAlexClient', () => {
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

  it('getWorkByDoi returns parsed metadata', async () => {
    const work: OpenAlexWork = {
      id: 'https://openalex.org/W123456789',
      doi: 'https://doi.org/10.1234/example',
      title: 'Attention Is All You Need',
      authorships: [
        { author: { display_name: 'Ashish Vaswani' }, author_position: 'first' },
        { author: { display_name: 'Noam Shazeer' } },
      ],
      publication_year: 2017,
      primary_location: {
        source: { display_name: 'NeurIPS' },
        landing_page_url: 'https://papers.nips.cc/paper/2017/hash/attention',
        pdf_url: 'https://arxiv.org/pdf/1706.03762.pdf',
      },
      type: 'journal-article',
      cited_by_count: 12000,
      concepts: [{ display_name: 'Artificial intelligence', score: 0.9 }],
      abstract_inverted_index: {
        Attention: [0],
        Is: [1],
        All: [2],
        You: [3],
        Need: [4],
      },
      open_access: { is_oa: true, oa_status: 'gold', oa_url: 'https://arxiv.org/pdf/1706.03762.pdf' },
    };
    mockFetch(work);

    const result = await getWorkByDoi('10.1234/example');

    expect(result).not.toBeNull();
    expect(result?.title).toBe('Attention Is All You Need');
    expect(result?.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
    expect(result?.year).toBe(2017);
    expect(result?.venue).toBe('NeurIPS');
    expect(result?.doi).toBe('10.1234/example');
    expect(result?.url).toBe('https://papers.nips.cc/paper/2017/hash/attention');
    expect(result?.pdfUrl).toBe('https://arxiv.org/pdf/1706.03762.pdf');
    expect(result?.isOpenAccess).toBe(true);
    expect(result?.citedByCount).toBe(12000);
    expect(result?.concepts).toEqual(['Artificial intelligence']);
    expect(result?.abstract).toBe('Attention Is All You Need');

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(decodeURIComponent(url)).toContain('/works/doi:10.1234/example');
  });

  it('getWorkByDoi normalizes DOI input', async () => {
    const work: OpenAlexWork = {
      id: 'https://openalex.org/W0001',
      doi: 'https://doi.org/10.5678/UPPER',
      title: 'Uppercase DOI',
      authorships: [],
      publication_year: 2020,
    };
    mockFetch(work);

    const result = await getWorkByDoi('DOI: 10.5678/UPPER');

    expect(result?.doi).toBe('10.5678/upper');
  });

  it('getWorkByDoi returns null for 404', async () => {
    mockFetch({ error: 'Not found' }, 404);

    const result = await getWorkByDoi('10.0000/missing');

    expect(result).toBeNull();
  });

  it('getWorkByDoi returns null for empty input', async () => {
    const result = await getWorkByDoi('   ');
    expect(result).toBeNull();
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('exists returns true for registered DOI', async () => {
    const work: OpenAlexWork = {
      id: 'https://openalex.org/W1234',
      doi: 'https://doi.org/10.1234/exists',
      title: 'Exists',
    };
    mockFetch(work);

    const result = await exists('10.1234/exists');

    expect(result).toBe(true);
  });

  it('exists returns false for missing DOI', async () => {
    mockFetch({ error: 'Not found' }, 404);

    const result = await exists('10.0000/missing');

    expect(result).toBe(false);
  });

  it('searchWorks returns parsed results and next cursor', async () => {
    mockFetch({
      meta: { count: 2, per_page: 1, page: 1, next_cursor: 'cursor:abc' },
      results: [
        {
          id: 'https://openalex.org/W1',
          title: 'First Result',
          authorships: [{ raw_author_name: 'Alice One' }],
          publication_year: 2020,
          primary_location: { source: { display_name: 'Journal One' } },
        } as OpenAlexWork,
      ],
    });

    const result = await searchWorks({ query: 'machine learning', limit: 1 });

    expect(result.total).toBe(2);
    expect(result.works).toHaveLength(1);
    expect(result.works[0]?.title).toBe('First Result');
    expect(result.works[0]?.authors).toEqual(['Alice One']);
    expect(result.nextCursor).toBe('cursor:abc');

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('search=machine+learning');
    expect(url).toContain('per-page=1');
  });

  it('searchWorks handles empty results', async () => {
    mockFetch({ meta: { count: 0, per_page: 10, page: 1 }, results: [] });

    const result = await searchWorks({ query: 'xyznonexistent' });

    expect(result.total).toBe(0);
    expect(result.works).toHaveLength(0);
    expect(result.nextCursor).toBeUndefined();
  });

  it('metadataToPlain returns a plain object', () => {
    const metadata = {
      id: 'https://openalex.org/WPlain',
      doi: '10.1234/plain',
      title: 'Plain',
      authors: ['Alice'],
      year: 2023,
      venue: 'Venue',
      url: 'https://example.com',
      pdfUrl: 'https://example.com/pdf',
      type: 'article',
      isOpenAccess: true,
      citedByCount: 42,
      abstract: 'Abstract text.',
      concepts: ['CS'],
    };

    const plain = metadataToPlain(metadata);

    expect(plain).toEqual({
      id: 'https://openalex.org/WPlain',
      doi: '10.1234/plain',
      title: 'Plain',
      authors: ['Alice'],
      year: 2023,
      venue: 'Venue',
      url: 'https://example.com',
      pdfUrl: 'https://example.com/pdf',
      type: 'article',
      isOpenAccess: true,
      citedByCount: 42,
      abstract: 'Abstract text.',
      concepts: ['CS'],
    });
  });
});
