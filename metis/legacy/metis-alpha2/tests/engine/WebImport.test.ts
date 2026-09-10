/**
 * Tests for WebImport metadata extraction.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { importFromUrl } from '../../engine/research/WebImport.js';

const originalFetch = globalThis.fetch;

describe('WebImport', () => {
  beforeEach(() => {
    globalThis.fetch = vi.fn();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
    vi.resetAllMocks();
  });

  function mockHtmlResponse(html: string, contentType = 'text/html') {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', contentType]]) as unknown as Headers,
      text: () => Promise.resolve(html),
      json: () => Promise.resolve({}),
    } as Response);
  }

  function mockJsonResponse(response: unknown) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      headers: new Map([['content-type', 'application/json']]) as unknown as Headers,
      text: () => Promise.resolve(JSON.stringify(response)),
      json: () => Promise.resolve(response),
    } as Response);
  }

  it('extracts metadata from citation meta tags', async () => {
    mockHtmlResponse(`
      <html><head>
        <meta name="citation_title" content="Attention Is All You Need">
        <meta name="citation_author" content="Ashish Vaswani">
        <meta name="citation_author" content="Noam Shazeer">
        <meta name="citation_publication_date" content="2017/01/01">
        <meta name="citation_journal_title" content="NeurIPS">
        <meta name="citation_doi" content="10.1234/attention">
        <meta name="citation_abstract" content="We propose a new simple network architecture.">
      </head><body></body></html>
    `);

    const result = await importFromUrl('https://example.com/paper');
    expect(result.title).toBe('Attention Is All You Need');
    expect(result.authors).toEqual(['Ashish Vaswani', 'Noam Shazeer']);
    expect(result.year).toBe(2017);
    expect(result.venue).toBe('NeurIPS');
    expect(result.doi).toBe('10.1234/attention');
    expect(result.abstract).toContain('new simple network architecture');
    expect(result.bibtex).toContain('@article');
    expect(result.source).toBe('meta');
  });

  it('extracts arXiv ID from URL', async () => {
    mockHtmlResponse(`
      <html><head>
        <meta name="citation_title" content="Sample Paper">
        <meta name="citation_author" content="Alice Author">
      </head><body></body></html>
    `);

    const result = await importFromUrl('https://arxiv.org/abs/2301.00001');
    expect(result.arxivId).toBe('2301.00001');
  });

  it('enriches metadata from Crossref when DOI is found', async () => {
    mockHtmlResponse(`
      <html><head>
        <meta name="citation_title" content="Fallback Title">
        <meta name="citation_doi" content="10.1234/example">
      </head><body></body></html>
    `);
    mockJsonResponse({
      status: 'ok',
      message: {
        type: 'journal-article',
        title: ['Crossref Title'],
        author: [{ given: 'Alice', family: 'Author' }],
        'published-print': { 'date-parts': [[2022, 3]] },
        'container-title': ['Journal of Examples'],
        DOI: '10.1234/example',
        abstract: 'Crossref abstract.',
      },
    });

    const result = await importFromUrl('https://example.com/paper');
    expect(result.source).toBe('crossref');
    expect(result.title).toBe('Crossref Title');
    expect(result.authors).toEqual(['Alice Author']);
    expect(result.year).toBe(2022);
    expect(result.venue).toBe('Journal of Examples');
    expect(result.doi).toBe('10.1234/example');
  });

  it('falls back to meta tags when Crossref fails', async () => {
    mockHtmlResponse(`
      <html><head>
        <meta name="citation_title" content="Fallback Title">
        <meta name="citation_doi" content="10.1234/missing">
        <meta name="citation_author" content="Bob Author">
      </head><body></body></html>
    `);
    vi.mocked(globalThis.fetch).mockRejectedValueOnce(new Error('Crossref error'));

    const result = await importFromUrl('https://example.com/paper');
    expect(result.title).toBe('Fallback Title');
    expect(result.authors).toEqual(['Bob Author']);
    expect(result.source).toBe('meta');
  });

  it('extracts DOI from URL when meta tag is absent', async () => {
    mockHtmlResponse(`
      <html><head>
        <meta name="citation_title" content="URL DOI Paper">
        <meta name="citation_author" content="Carol Author">
      </head><body></body></html>
    `);

    const result = await importFromUrl('https://doi.org/10.5678/url-doi');
    expect(result.doi).toBe('10.5678/url-doi');
  });

  it('rejects direct PDF URLs', async () => {
    mockHtmlResponse('', 'application/pdf');
    await expect(importFromUrl('https://example.com/paper.pdf')).rejects.toThrow('URL points directly to a PDF');
  });

  it('throws on HTTP errors', async () => {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: false,
      status: 404,
      statusText: 'Not Found',
      headers: new Map() as unknown as Headers,
      text: () => Promise.resolve('Not found'),
    } as Response);
    await expect(importFromUrl('https://example.com/missing')).rejects.toThrow('HTTP 404');
  });
});
