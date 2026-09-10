/**
 * Tests for LiteratureReviewEngine.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  clusterPapers,
  detectConflicts,
  detectGaps,
  analyzeTrends,
  buildLiteratureReview,
  expandByCitationNetwork,
  generateLiteratureReview,
} from '../../engine/research/LiteratureReviewEngine.js';
import type { ReviewPaper } from '../../engine/research/LiteratureReviewEngine.js';
import * as SemanticScholarClient from '../../engine/research/SemanticScholarClient.js';

vi.mock('../../engine/research/SemanticScholarClient.js', async (importOriginal) => {
  const actual = await importOriginal<typeof SemanticScholarClient>();
  return {
    ...actual,
    searchPapers: vi.fn(),
    getPaperRecommendations: vi.fn(),
    getPaperById: vi.fn(),
  };
});

function makePaper(overrides: Partial<ReviewPaper> & { title: string; abstract: string }): ReviewPaper {
  return {
    id: `p-${overrides.title}`,
    title: overrides.title,
    authors: overrides.authors ?? ['Alice Author'],
    year: overrides.year ?? 2023,
    venue: overrides.venue ?? 'Test Venue',
    abstract: overrides.abstract,
    doi: overrides.doi,
    arxivId: overrides.arxivId,
    url: overrides.url,
    citationCount: overrides.citationCount,
  };
}

describe('LiteratureReviewEngine clustering', () => {
  it('groups papers by shared keywords', () => {
    const papers = [
      makePaper({ title: 'Attention Is All You Need', abstract: 'We propose transformer attention mechanism for sequence modeling.' }),
      makePaper({ title: 'BERT Pretraining', abstract: 'We pretrain deep bidirectional transformers using masked language modeling.' }),
      makePaper({ title: 'ResNet Deep Residual Learning', abstract: 'We introduce residual networks for image recognition.' }),
    ];
    const clusters = clusterPapers(papers, 2);
    expect(clusters.length).toBeGreaterThanOrEqual(1);
    expect(clusters[0]!.papers.length).toBeGreaterThanOrEqual(1);
  });

  it('returns empty clusters for empty input', () => {
    expect(clusterPapers([], 3)).toEqual([]);
  });
});

describe('LiteratureReviewEngine conflict detection', () => {
  it('flags a negative-vs-positive finding pair', () => {
    const papers = [
      makePaper({ title: 'X improves accuracy', abstract: 'Our results show that method X improves accuracy significantly.' }),
      makePaper({ title: 'X does not improve', abstract: 'We find no evidence that method X improves accuracy.' }),
    ];
    const conflicts = detectConflicts(papers);
    expect(conflicts.length).toBeGreaterThan(0);
    expect(conflicts[0]!.type).toBe('finding');
  });

  it('returns no conflicts when abstracts are unrelated', () => {
    const papers = [
      makePaper({ title: 'Computer vision survey', abstract: 'We survey recent advances in computer vision.' }),
      makePaper({ title: 'NLP survey', abstract: 'We survey recent advances in natural language processing.' }),
    ];
    expect(detectConflicts(papers)).toEqual([]);
  });
});

describe('LiteratureReviewEngine gap detection', () => {
  it('flags singleton clusters as gaps', () => {
    const papers = [
      makePaper({ title: 'Transformer architectures in NLP', abstract: 'We study transformer architectures for natural language processing pipelines.' }),
      makePaper({ title: 'Convolutional networks for images', abstract: 'We evaluate convolutional neural networks for image classification benchmarks.' }),
    ];
    const gaps = detectGaps(papers, 'transformers CNNs');
    expect(gaps.some((g) => g.includes('Only one paper'))).toBe(true);
  });

  it('flags missing query terms', () => {
    const papers = [
      makePaper({ title: 'Transformers', abstract: 'We study transformers.' }),
    ];
    const gaps = detectGaps(papers, 'transformers reinforcement learning');
    expect(gaps.some((g) => g.includes('reinforcement'))).toBe(true);
  });
});

describe('LiteratureReviewEngine trend analysis', () => {
  it('computes year histogram, venues, and authors', () => {
    const papers = [
      makePaper({ title: 'A', abstract: 'Abstract A', year: 2021, venue: 'Venue X', authors: ['Alice', 'Bob'] }),
      makePaper({ title: 'B', abstract: 'Abstract B', year: 2022, venue: 'Venue X', authors: ['Alice', 'Carol'] }),
      makePaper({ title: 'C', abstract: 'Abstract C', year: 2022, venue: 'Venue Y', authors: ['Bob'] }),
    ];
    const trends = analyzeTrends(papers);
    expect(trends.yearHistogram[2022]).toBe(2);
    expect(trends.topVenues[0]!.venue).toBe('Venue X');
    expect(trends.topAuthors[0]!.author).toBe('Alice');
  });
});

describe('LiteratureReviewEngine review builder', () => {
  it('generates markdown with clusters, gaps, and references', () => {
    const papers = [
      makePaper({ title: 'Transformer survey', abstract: 'We survey transformer architectures.' }),
      makePaper({ title: 'CNN survey', abstract: 'We survey convolutional networks.' }),
    ];
    const review = buildLiteratureReview(papers, 'deep learning surveys');
    expect(review.papers).toHaveLength(2);
    expect(review.markdown).toContain('# Literature Review:');
    expect(review.markdown).toContain('## Thematic Clusters');
    expect(review.markdown).toContain('## References');
    expect(review.references.length).toBe(2);
  });

  it('saves a note when saveNote is true', () => {
    const papers = [
      makePaper({ title: 'Note test', abstract: 'Abstract for note test.' }),
    ];
    const review = buildLiteratureReview(papers, 'note test', { saveNote: true });
    expect(review.noteId).toBeDefined();
    expect(review.noteId).toMatch(/^literature-review-/);
  });
});

describe('LiteratureReviewEngine citation network expansion', () => {
  const mocked = vi.mocked(SemanticScholarClient);

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('expands seed ids with citations and references', async () => {
    mocked.getPaperRecommendations.mockImplementation(async ({ type }) => ({
      offset: 0,
      data: type === 'citations'
        ? [{ citingPaper: { paperId: 'c1', title: 'Citing Paper', authors: [{ name: 'Bob' }], year: 2024, venue: 'Venue' } }]
        : [{ citedPaper: { paperId: 'r1', title: 'Referenced Paper', authors: [{ name: 'Carol' }], year: 2022, venue: 'Venue' } }],
    }));

    const expanded = await expandByCitationNetwork(['seed1'], { maxPerSeed: 5, maxTotal: 10 });
    expect(expanded).toHaveLength(2);
    expect(expanded.some((p) => p.id === 'semantic-scholar:c1')).toBe(true);
    expect(expanded.some((p) => p.id === 'semantic-scholar:r1')).toBe(true);
  });

  it('deduplicates expanded papers', async () => {
    mocked.getPaperRecommendations.mockResolvedValue({
      offset: 0,
      data: [
        { citingPaper: { paperId: 'dup', title: 'Duplicate', authors: [{ name: 'Bob' }], year: 2024 } },
        { citedPaper: { paperId: 'dup', title: 'Duplicate', authors: [{ name: 'Bob' }], year: 2024 } },
      ],
    });

    const expanded = await expandByCitationNetwork(['seed1'], { maxPerSeed: 5, maxTotal: 10 });
    expect(expanded).toHaveLength(1);
  });

  it('generateLiteratureReview reports network stats when expandNetwork is true', async () => {
    mocked.searchPapers.mockResolvedValue({ total: 1, offset: 0, data: [] });
    mocked.getPaperRecommendations.mockImplementation(async ({ type }) => ({
      offset: 0,
      data: type === 'citations'
        ? [{ citingPaper: { paperId: 'c1', title: 'Citing Paper', authors: [{ name: 'Bob' }], year: 2024 } }]
        : [{ citedPaper: { paperId: 'r1', title: 'Referenced Paper', authors: [{ name: 'Carol' }], year: 2022 } }],
    }));

    const review = await generateLiteratureReview({
      identifiers: ['DOI:10.1234/example'],
      maxResults: 10,
      expandNetwork: true,
    });
    expect(review.networkStats.seeds).toBe(0);
    expect(review.networkStats.expanded).toBe(2);
    expect(review.markdown).toContain('**Network**:');
  });

  it('normalizes DOI and arXiv seed identifiers for Semantic Scholar', async () => {
    mocked.getPaperRecommendations.mockResolvedValue({ offset: 0, data: [] });

    await expandByCitationNetwork(['10.1234/example', '1706.03762'], { maxPerSeed: 3, maxTotal: 5 });

    expect(mocked.getPaperRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({ paperId: 'DOI:10.1234/example' }),
    );
    expect(mocked.getPaperRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({ paperId: 'ARXIV:1706.03762' }),
    );
  });

  it('resolves Semantic Scholar paper IDs as seed identifiers', async () => {
    mocked.getPaperById.mockResolvedValue({
      paperId: 's1',
      title: 'Semantic Scholar Seed',
      abstract: 'Abstract from SS.',
      authors: [{ name: 'Eve' }],
      year: 2023,
    });

    const review = await generateLiteratureReview({
      identifiers: ['semantic-scholar:s1'],
      maxResults: 5,
    });

    expect(review.papers).toHaveLength(1);
    expect(review.papers[0]!.title).toBe('Semantic Scholar Seed');
  });

  it('strips semantic-scholar: prefix before network expansion', async () => {
    mocked.getPaperRecommendations.mockResolvedValue({ offset: 0, data: [] });

    await expandByCitationNetwork(['semantic-scholar:seed1'], { maxPerSeed: 3, maxTotal: 5 });

    expect(mocked.getPaperRecommendations).toHaveBeenCalledWith(
      expect.objectContaining({ paperId: 'seed1' }),
    );
  });

  it('enriches abstracts for expanded papers when getPaperById returns details', async () => {
    mocked.getPaperRecommendations.mockResolvedValue({
      offset: 0,
      data: [{ citingPaper: { paperId: 'c1', title: 'Citing Paper', authors: [{ name: 'Bob' }], year: 2024 } }],
    });
    mocked.getPaperById.mockResolvedValue({
      paperId: 'c1',
      title: 'Citing Paper',
      abstract: 'This paper improves transformer efficiency.',
      authors: [{ name: 'Bob' }],
      year: 2024,
    });

    const expanded = await expandByCitationNetwork(['seed1'], { maxPerSeed: 5, maxTotal: 10 });
    expect(expanded).toHaveLength(1);
    expect(expanded[0]!.abstract).toBe('This paper improves transformer efficiency.');
  });
});
