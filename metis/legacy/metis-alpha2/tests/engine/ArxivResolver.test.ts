/**
 * Tests for ArxivResolver.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { resolveArxiv, arxivMetadataToPlain } from '../../engine/research/ArxivResolver.js';

describe('ArxivResolver', () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockFetch(xml: string, status = 200) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: status >= 200 && status < 300,
      status,
      statusText: status === 404 ? 'Not Found' : 'OK',
      text: () => Promise.resolve(xml),
      json: () => Promise.resolve({}),
    } as Response);
  }

  const sampleAtom = `<?xml version="1.0" encoding="UTF-8"?>
<feed xmlns="http://www.w3.org/2005/Atom" xmlns:arxiv="http://arxiv.org/schemas/atom">
  <entry>
    <id>https://arxiv.org/abs/1706.03762</id>
    <title>Attention Is All You Need</title>
    <summary>We propose a new simple network architecture.</summary>
    <author><name>Ashish Vaswani</name></author>
    <author><name>Noam Shazeer</name></author>
    <published>2017-06-12T00:00:00Z</published>
    <arxiv:primary_category term="cs.CL"/>
    <category term="cs.CL"/>
    <category term="cs.LG"/>
    <arxiv:comment>Accepted at NeurIPS 2017</arxiv:comment>
    <arxiv:doi>10.1234/attention</arxiv:doi>
    <arxiv:journal_ref>NeurIPS 2017</arxiv:journal_ref>
  </entry>
</feed>`;

  it('resolves an arXiv ID to metadata', async () => {
    mockFetch(sampleAtom);

    const result = await resolveArxiv('1706.03762');

    expect(result).not.toBeNull();
    expect(result?.arxivId).toBe('1706.03762');
    expect(result?.title).toBe('Attention Is All You Need');
    expect(result?.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
    expect(result?.year).toBe(2017);
    expect(result?.abstract).toBe('We propose a new simple network architecture.');
    expect(result?.venue).toBe('NeurIPS 2017');
    expect(result?.doi).toBe('10.1234/attention');
    expect(result?.primaryCategory).toBe('cs.CL');
    expect(result?.categories).toContain('cs.LG');
    expect(result?.url).toBe('https://arxiv.org/abs/1706.03762');
    expect(result?.pdfUrl).toBe('https://arxiv.org/pdf/1706.03762.pdf');
  });

  it('normalizes various arXiv ID formats', async () => {
    mockFetch(sampleAtom);
    await resolveArxiv('https://arxiv.org/abs/1706.03762');
    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('id_list=1706.03762');
  });

  it('returns null for empty input', async () => {
    const result = await resolveArxiv('   ');
    expect(result).toBeNull();
  });

  it('returns null when arXiv returns 404', async () => {
    mockFetch('<feed></feed>', 404);
    const result = await resolveArxiv('0000.00000');
    expect(result).toBeNull();
  });

  it('returns null when entry is missing', async () => {
    mockFetch('<?xml version="1.0"?><feed></feed>');
    const result = await resolveArxiv('1706.03762');
    expect(result).toBeNull();
  });

  it('converts metadata to plain object', () => {
    const metadata = {
      arxivId: '1706.03762',
      title: 'Attention Is All You Need',
      authors: ['A', 'B'],
      year: 2017,
      venue: 'NeurIPS',
      abstract: 'Abstract.',
      url: 'https://arxiv.org/abs/1706.03762',
      pdfUrl: 'https://arxiv.org/pdf/1706.03762.pdf',
      doi: '10.1234/attention',
      primaryCategory: 'cs.CL',
      categories: ['cs.CL'],
    };
    expect(arxivMetadataToPlain(metadata)).toEqual(metadata);
  });
});
