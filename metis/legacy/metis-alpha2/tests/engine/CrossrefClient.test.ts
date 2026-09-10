/**
 * Tests for CrossrefClient.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import {
  exists,
  getWorkByDoi,
  getRawWorkByDoi,
  searchWorks,
  metadataToPlain,
  type CrossrefWorkMessage,
} from '../../engine/research/CrossrefClient.js';

describe('CrossrefClient', () => {
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

  function makeWorkMessage(work: Record<string, unknown>): CrossrefWorkMessage {
    return {
      status: 'ok',
      message: work as CrossrefWorkMessage['message'],
    };
  }

  it('getWorkByDoi returns parsed metadata', async () => {
    mockFetch(
      makeWorkMessage({
        DOI: '10.1145/276675.276685',
        title: ['The Anatomy of a Large-Scale Search Engine'],
        author: [{ given: 'S.', family: 'Brin' }, { given: 'L.', family: 'Page' }],
        issued: { 'date-parts': [[1998]] },
        'container-title': ['Computer Networks and ISDN Systems'],
        URL: 'https://doi.org/10.1145/276675.276685',
        type: 'journal-article',
        publisher: 'ACM',
        'is-referenced-by-count': 15000,
        'references-count': 50,
      })
    );

    const result = await getWorkByDoi('10.1145/276675.276685');

    expect(result).not.toBeNull();
    expect(result?.title).toBe('The Anatomy of a Large-Scale Search Engine');
    expect(result?.authors).toEqual(['S. Brin', 'L. Page']);
    expect(result?.year).toBe(1998);
    expect(result?.venue).toBe('Computer Networks and ISDN Systems');
    expect(result?.doi).toBe('10.1145/276675.276685');
    expect(result?.type).toBe('journal-article');
    expect(result?.publisher).toBe('ACM');
    expect(result?.referencedByCount).toBe(15000);
    expect(result?.referencesCount).toBe(50);

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(decodeURIComponent(url)).toContain('/works/10.1145/276675.276685');
  });

  it('getWorkByDoi normalizes DOI prefixes and lowercases', async () => {
    mockFetch(
      makeWorkMessage({
        DOI: '10.1234/sample',
        title: ['Sample'],
        author: [],
        issued: { 'date-parts': [[2020]] },
        'container-title': ['Journal'],
      })
    );

    const result = await getWorkByDoi('https://doi.org/10.1234/SAMPLE');

    expect(result).not.toBeNull();
    expect(result?.doi).toBe('10.1234/sample');
  });

  it('getWorkByDoi strips abstract JATS tags', async () => {
    mockFetch(
      makeWorkMessage({
        DOI: '10.1234/jats',
        title: ['JATS Abstract Paper'],
        author: [{ name: 'Alice Author' }],
        issued: { 'date-parts': [[2022]] },
        'container-title': ['Journal'],
        abstract: '<jats:p>This is <jats:italic>important</jats:italic>.</jats:p>',
      })
    );

    const result = await getWorkByDoi('10.1234/jats');

    expect(result?.abstract).toBe('This is important.');
  });

  it('getWorkByDoi returns null for 404', async () => {
    mockFetch({ status: 'error', 'message-type': 'work' }, 404);

    const result = await getWorkByDoi('10.0000/missing');

    expect(result).toBeNull();
  });

  it('getRawWorkByDoi returns update-to metadata', async () => {
    mockFetch(
      makeWorkMessage({
        DOI: '10.1234/retracted',
        title: ['Retracted Paper'],
        author: [],
        issued: { 'date-parts': [[2020]] },
        'container-title': ['Journal'],
        'update-to': [
          { type: 'retraction', source: 'retraction-watch', label: 'Retraction', DOI: '10.1234/notice' },
        ],
      })
    );

    const result = await getRawWorkByDoi('10.1234/retracted');

    expect(result).not.toBeNull();
    expect(result?.DOI).toBe('10.1234/retracted');
    expect(result?.['update-to']).toHaveLength(1);
    expect(result?.['update-to']?.[0]?.type).toBe('retraction');
  });

  it('exists returns true for registered DOI', async () => {
    mockFetch(makeWorkMessage({ DOI: '10.1234/exists', title: ['Exists'], author: [] }));

    const result = await exists('10.1234/exists');

    expect(result).toBe(true);
  });

  it('exists returns false for missing DOI', async () => {
    mockFetch({ status: 'error' }, 404);

    const result = await exists('10.0000/missing');

    expect(result).toBe(false);
  });

  it('exists returns false for empty input', async () => {
    const result = await exists('   ');
    expect(result).toBe(false);
    expect(globalThis.fetch).not.toHaveBeenCalled();
  });

  it('searchWorks returns parsed results and pagination', async () => {
    mockFetch({
      status: 'ok',
      message: {
        'total-results': 2,
        'items-per-page': 1,
        items: [
          {
            DOI: '10.1234/one',
            title: ['First Result'],
            author: [{ family: 'One' }],
            issued: { 'date-parts': [[2020]] },
            'container-title': ['Journal One'],
          },
        ],
      },
    });

    const result = await searchWorks({ query: 'machine learning', limit: 1, offset: 0 });

    expect(result.total).toBe(2);
    expect(result.works).toHaveLength(1);
    expect(result.works[0]?.title).toBe('First Result');
    expect(result.nextOffset).toBe(1);

    const url = vi.mocked(globalThis.fetch).mock.calls[0]?.[0] as string;
    expect(url).toContain('query=machine+learning');
    expect(url).toContain('rows=1');
    expect(url).toContain('offset=0');
  });

  it('searchWorks handles empty results', async () => {
    mockFetch({
      status: 'ok',
      message: { 'total-results': 0, 'items-per-page': 10, items: [] },
    });

    const result = await searchWorks({ query: 'xyznonexistent' });

    expect(result.total).toBe(0);
    expect(result.works).toHaveLength(0);
    expect(result.nextOffset).toBeUndefined();
  });

  it('metadataToPlain returns a plain object', () => {
    const metadata = {
      doi: '10.1234/plain',
      title: 'Plain',
      authors: ['Alice'],
      year: 2023,
      venue: 'Venue',
      url: 'https://doi.org/10.1234/plain',
      type: 'journal-article',
      publisher: 'Publisher',
      abstract: 'Abstract',
      referencedByCount: 10,
      referencesCount: 5,
    };

    const plain = metadataToPlain(metadata);

    expect(plain).toEqual({
      doi: '10.1234/plain',
      title: 'Plain',
      authors: ['Alice'],
      year: 2023,
      venue: 'Venue',
      url: 'https://doi.org/10.1234/plain',
      type: 'journal-article',
      publisher: 'Publisher',
      abstract: 'Abstract',
      subject: undefined,
      referencedByCount: 10,
      referencesCount: 5,
    });
  });
});
