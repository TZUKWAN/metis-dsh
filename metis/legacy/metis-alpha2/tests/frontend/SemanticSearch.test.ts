/**
 * Tests for store semantic ranking via RagEngine (rankPapersWithRag).
 */

import { describe, it, expect } from 'vitest';
import { rankPapersWithRag, rankPapersByRelevance, type PaperItem } from '../../src/store';

function paper(id: string, overrides: Partial<PaperItem> = {}): PaperItem {
  return {
    id,
    title: `Title ${id}`,
    authors: ['Author'],
    year: 2024,
    venue: 'V',
    abstract: '',
    tags: [],
    notes: '',
    readStatus: 'unread',
    rating: 0,
    referenceIds: [],
    addedAt: 1,
    ...overrides,
  } as PaperItem;
}

describe('rankPapersWithRag', () => {
  it('returns papers in descending relevance order for matching terms', () => {
    const papers = [
      paper('a', { title: 'Deep learning overview', abstract: 'neural networks' }),
      paper('b', { title: 'Unrelated topic', abstract: 'cooking recipes' }),
      paper('c', { title: 'Neural methods', abstract: 'deep neural architectures' }),
    ];
    const ranked = rankPapersWithRag(papers, 'neural networks');
    const ids = ranked.map((p) => p.id);
    // Both neural papers match; the unrelated one is dropped.
    expect(ids).not.toContain('b');
    expect(ids).toContain('a');
    expect(ids).toContain('c');
  });

  it('includes PDF-body-only matches when full text is indexed', () => {
    const papers = [
      paper('body-only', { title: 'No keyword in title', abstract: 'unrelated abstract', pdfText: 'The keyphrase magnetohydrodynamic flow is in the body only.' }),
      paper('other', { title: 'Different paper', abstract: 'something else' }),
    ];
    const ranked = rankPapersWithRag(papers, 'magnetohydrodynamic');
    expect(ranked.map((p) => p.id)).toEqual(['body-only']);
  });

  it('returns the original list when the query is empty', () => {
    const papers = [paper('a'), paper('b')];
    expect(rankPapersWithRag(papers, '   ')).toHaveLength(2);
  });

  it('falls back gracefully: still returns matches even with a single document', () => {
    // The smoothed IDF fix means single-document search returns hits.
    const papers = [paper('solo', { title: 'Graph', abstract: 'graph neural' })];
    const ranked = rankPapersWithRag(papers, 'graph');
    expect(ranked.map((p) => p.id)).toEqual(['solo']);
  });
});

describe('rankPapersByRelevance (legacy TF-IDF, retained)', () => {
  it('still ranks matching papers (backward compatibility)', () => {
    const papers = [
      paper('a', { title: 'alpha beta' }),
      paper('b', { title: 'gamma delta' }),
    ];
    const ranked = rankPapersByRelevance(papers, 'alpha');
    expect(ranked[0]!.id).toBe('a');
  });
});
