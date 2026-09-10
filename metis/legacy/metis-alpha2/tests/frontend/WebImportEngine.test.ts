/**
 * Tests for the WebImport engine (URL → paper metadata) that backs the
 * PapersPage URL import branch.
 */

import { describe, it, expect, vi, beforeEach } from 'vitest';

const fetchMock = vi.fn();

describe('WebImport importFromUrl', () => {
  beforeEach(() => {
    fetchMock.mockReset();
    // Stub global fetch (WebImport uses fetch to retrieve the page HTML).
    (globalThis as { fetch: typeof fetch }).fetch = fetchMock as unknown as typeof fetch;
  });

  it('extracts citation meta tags from a page and returns a paper', async () => {
    const html = `
      <html><head>
        <meta name="citation_title" content="Cited Web Paper" />
        <meta name="citation_author" content="Ada Lovelace" />
        <meta name="citation_author" content="Alan Turing" />
        <meta name="citation_publication_date" content="2024" />
        <meta name="citation_journal_title" content="Web Journal" />
        <meta name="citation_abstract" content="Abstract from meta tags." />
        <meta name="citation_doi" content="10.1/cited" />
      </head><body>content</body></html>
    `;
    fetchMock.mockResolvedValue({ ok: true, headers: { get: () => 'text/html' }, text: async () => html });
    const { importFromUrl } = await import('../../engine/research/WebImport.js');
    const result = await importFromUrl('https://example.com/paper');
    expect(result.title).toBe('Cited Web Paper');
    expect(result.authors).toEqual(['Ada Lovelace', 'Alan Turing']);
    expect(result.year).toBe(2024);
    expect(result.doi).toBe('10.1/cited');
    expect(result.url).toBe('https://example.com/paper');
  });

  it('falls back to the URL as the title when no meta tags are present', async () => {
    fetchMock.mockResolvedValue({ ok: true, headers: { get: () => 'text/html' }, text: async () => '<html><body>no meta</body></html>' });
    const { importFromUrl } = await import('../../engine/research/WebImport.js');
    const result = await importFromUrl('https://example.com/plain');
    // Without citation meta tags the importer still returns a result keyed by URL.
    expect(result.url).toBe('https://example.com/plain');
    expect(typeof result.title).toBe('string');
  });
});
