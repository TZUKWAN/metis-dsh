/**
 * Tests for SemanticScholarClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  searchPapers,
  getPaperById,
  paperToPlain,
  type SemanticScholarSearchResult,
  type SemanticScholarPaper,
} from '../../engine/research/SemanticScholarClient.js';

describe('SemanticScholarClient', () => {
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

  it('searchPapers returns parsed results', async () => {
    const apiResponse: SemanticScholarSearchResult = {
      total: 1,
      offset: 0,
      data: [
        {
          paperId: 'abc123',
          title: 'Attention Is All You Need',
          abstract: 'We propose a new simple network architecture.',
          year: 2017,
          venue: 'NeurIPS',
          authors: [{ name: 'Ashish Vaswani' }, { name: 'Noam Shazeer' }],
          externalIds: { DOI: '10.1234/attention', ArXiv: '1706.03762' },
          citationCount: 1000,
          referenceCount: 50,
          openAccessPdf: { url: 'https://arxiv.org/pdf/1706.03762.pdf' },
        } as SemanticScholarPaper,
      ],
    };
    mockFetch(apiResponse);

    const result = await searchPapers({ query: 'attention transformer', limit: 5 });

    expect(result.total).toBe(1);
    expect(result.data).toHaveLength(1);
    expect(result.data[0]?.title).toBe('Attention Is All You Need');
    expect(result.data[0]?.authors?.map((a) => a.name)).toEqual(['Ashish Vaswani', 'Noam Shazeer']);

    const call = vi.mocked(globalThis.fetch).mock.calls[0];
    const url = call[0] as string;
    expect(url).toContain('query=attention+transformer');
    expect(url).toContain('limit=5');
  });

  it('searchPapers handles empty results', async () => {
    mockFetch({ total: 0, offset: 0, data: [] });

    const result = await searchPapers({ query: 'xyznonexistent' });

    expect(result.total).toBe(0);
    expect(result.data).toHaveLength(0);
  });

  it('searchPapers throws on API error', async () => {
    mockFetch({ error: 'Rate limit exceeded' }, 429);

    await expect(searchPapers({ query: 'transformer' })).rejects.toThrow('Semantic Scholar API error 429');
  });

  it('getPaperById returns paper details', async () => {
    const paper: SemanticScholarPaper = {
      paperId: 'def456',
      title: 'BERT: Pre-training',
      year: 2019,
      authors: [{ name: 'Jacob Devlin' }],
    };
    mockFetch(paper);

    const result = await getPaperById({ paperId: 'def456' });

    expect(result).not.toBeNull();
    expect(result?.title).toBe('BERT: Pre-training');
  });

  it('getPaperById returns null for 404', async () => {
    mockFetch({ error: 'Not found' }, 404);

    const result = await getPaperById({ paperId: 'missing' });

    expect(result).toBeNull();
  });

  it('paperToPlain flattens paper structure', () => {
    const paper: SemanticScholarPaper = {
      paperId: 'ghi789',
      title: 'Diffusion Models',
      year: 2020,
      venue: 'NeurIPS',
      abstract: 'Diffusion models beat GANs.',
      authors: [{ name: 'Jonathan Ho' }],
      externalIds: { DOI: '10.1234/diff', ArXiv: '2006.11239' },
      citationCount: 500,
      referenceCount: 30,
      openAccessPdf: { url: 'https://pdf.url' },
    };

    const plain = paperToPlain(paper);

    expect(plain).toEqual({
      paperId: 'ghi789',
      title: 'Diffusion Models',
      authors: ['Jonathan Ho'],
      year: 2020,
      venue: 'NeurIPS',
      abstract: 'Diffusion models beat GANs.',
      doi: '10.1234/diff',
      arxivId: '2006.11239',
      url: undefined,
      citationCount: 500,
      referenceCount: 30,
      openAccessPdf: 'https://pdf.url',
    });
  });
});
