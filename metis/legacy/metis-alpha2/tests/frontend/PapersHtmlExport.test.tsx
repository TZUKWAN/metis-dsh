/**
 * papersToHtml: library → self-contained shareable HTML page.
 *
 * @vitest-environment jsdom
 */

import { describe, expect, it } from 'vitest';
import { papersToHtml } from '../../src/lib/papersHtml';
import type { PaperItem } from '../../src/store';

function makePaper(overrides: Partial<PaperItem> & { id: string; title: string }): PaperItem {
  return {
    authors: [],
    year: 2024,
    venue: '',
    abstract: '',
    tags: [],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    starred: false,
    archived: false,
    referenceIds: [],
    addedAt: 0,
    ...overrides,
  };
}

describe('papersToHtml', () => {
  it('renders a self-contained HTML page with every paper', () => {
    const html = papersToHtml([
      makePaper({ id: 'p1', title: 'Paper Alpha', authors: ['Alice'], year: 2023, venue: 'JMLR', abstract: 'Alpha abstract.', doi: '10.1/a', tags: ['nlp'] }),
      makePaper({ id: 'p2', title: 'Paper Beta', authors: ['Bob'], arxivId: '2401.0001' }),
    ], 'zh');

    expect(html).toContain('<!DOCTYPE html>');
    expect(html).toContain('Paper Alpha');
    expect(html).toContain('Paper Beta');
    expect(html).toContain('Alice');
    expect(html).toContain('Alpha abstract.');
    expect(html).toContain('DOI: 10.1/a');
    expect(html).toContain('arXiv: 2401.0001');
    expect(html).toContain('nlp');
    // Self-contained: inline styles, no external references.
    expect(html).toContain('<style>');
    expect(html).not.toContain('src="http');
  });

  it('escapes HTML in paper fields', () => {
    const html = papersToHtml([
      makePaper({ id: 'p1', title: 'A <script>alert(1)</script> title', abstract: 'x & y' }),
    ], 'en');
    expect(html).not.toContain('<script>alert(1)</script>');
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('x &amp; y');
  });

  it('renders an empty library page', () => {
    const html = papersToHtml([], 'en');
    expect(html).toContain('Paper Library');
    expect(html).toContain('0 papers');
  });
});
