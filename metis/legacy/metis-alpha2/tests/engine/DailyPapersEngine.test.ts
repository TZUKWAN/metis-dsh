/**
 * Tests for DailyPapersEngine.
 */

import { describe, it, expect, vi } from 'vitest';
import {
  fetchCategoryRss,
  fetchDailyPapers,
  generateDailyPapersBriefing,
} from '../../engine/research/DailyPapersEngine.js';
import * as RssFeedResolver from '../../engine/research/RssFeedResolver.js';

vi.mock('../../engine/research/RssFeedResolver.js', async (importOriginal) => {
  const actual = await importOriginal<typeof RssFeedResolver>();
  return {
    ...actual,
    fetchRssFeed: vi.fn(),
  };
});

const mocked = vi.mocked(RssFeedResolver);

describe('DailyPapersEngine', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('preserves original category case in RSS URLs', async () => {
    mocked.fetchRssFeed.mockResolvedValue({ title: '', link: '', description: '', entries: [] });

    await fetchCategoryRss('arxiv:cs.AI');
    expect(mocked.fetchRssFeed).toHaveBeenCalledWith('http://export.arxiv.org/rss/cs.AI', 15000);
  });

  it('maps aliases while preserving canonical case', async () => {
    mocked.fetchRssFeed.mockResolvedValue({ title: '', link: '', description: '', entries: [] });

    await fetchCategoryRss('AI');
    expect(mocked.fetchRssFeed).toHaveBeenCalledWith('http://export.arxiv.org/rss/cs.AI', 15000);
  });

  it('fetches and parses an arXiv category RSS feed', async () => {
    mocked.fetchRssFeed.mockResolvedValue({
      title: 'cs.AI updates',
      link: 'http://example.com',
      description: '',
      entries: [
        {
          id: '1',
          title: 'A Great AI Paper',
          link: 'http://arxiv.org/abs/1234.56789',
          summary: 'We propose a great method.',
          authors: ['Alice Author'],
          publishedAt: Date.now(),
          categories: ['cs.AI'],
        },
      ],
    });

    const entries = await fetchCategoryRss('cs.AI');
    expect(entries).toHaveLength(1);
    expect(entries[0]!.title).toBe('A Great AI Paper');
    expect(entries[0]!.categories).toContain('cs.AI');
    expect(entries[0]!.source).toBe('arxiv');
  });

  it('deduplicates papers across categories and ranks by recency + keywords', async () => {
    const now = Date.now();
    mocked.fetchRssFeed.mockResolvedValue({
      title: 'feed',
      link: 'http://example.com',
      description: '',
      entries: [
        {
          id: '1',
          title: 'Transformer Efficiency',
          link: 'http://arxiv.org/abs/1',
          summary: 'We improve transformer efficiency.',
          authors: ['A'],
          publishedAt: now,
          categories: ['cs.AI'],
        },
        {
          id: '2',
          title: 'Old Paper',
          link: 'http://arxiv.org/abs/2',
          summary: 'We study something else.',
          authors: ['B'],
          publishedAt: now - 10 * 24 * 60 * 60 * 1000,
          categories: ['cs.AI'],
        },
        {
          id: '1',
          title: 'Transformer Efficiency',
          link: 'http://arxiv.org/abs/1',
          summary: 'We improve transformer efficiency.',
          authors: ['A'],
          publishedAt: now,
          categories: ['cs.CL'],
        },
      ],
    });

    const { papers, totalFetched } = await fetchDailyPapers(['cs.AI', 'cs.CL'], { maxResults: 5, keywords: ['transformer'] });
    expect(papers).toHaveLength(2);
    expect(totalFetched).toBe(6); // raw entries before dedup (3 per category x 2 categories)
    expect(papers[0]!.title).toBe('Transformer Efficiency');
    expect(papers[0]!.score).toBeGreaterThan(papers[1]!.score);
    expect(papers[0]!.categories).toContain('cs.AI');
    expect(papers[0]!.sources).toContain('arxiv');
  });

  it('boosts papers that appear in multiple sources', async () => {
    const now = Date.now();
    mocked.fetchRssFeed.mockImplementation(async (url: string) => {
      const isBio = url.includes('biorxiv');
      return {
        title: 'feed',
        link: 'http://example.com',
        description: '',
        entries: isBio
          ? [
              {
                id: 'cross',
                title: 'Cross-Source Paper',
                link: 'http://example.com/cross',
                summary: 'Important biology meets AI.',
                authors: ['A'],
                publishedAt: now,
                categories: ['MBIOC'],
              },
            ]
          : [
              {
                id: 'cross',
                title: 'Cross-Source Paper',
                link: 'http://example.com/cross',
                summary: 'Important biology meets AI.',
                authors: ['A'],
                publishedAt: now,
                categories: ['cs.AI'],
              },
              {
                id: 'single',
                title: 'Single-Source Paper',
                link: 'http://example.com/single',
                summary: 'Only in one feed.',
                authors: ['B'],
                publishedAt: now,
                categories: ['cs.AI'],
              },
            ],
      };
    });

    const { papers } = await fetchDailyPapers(['arxiv:cs.AI', 'biorxiv:MBIOC'], { maxResults: 5 });
    const cross = papers.find((p) => p.title === 'Cross-Source Paper');
    const single = papers.find((p) => p.title === 'Single-Source Paper');
    expect(cross).toBeDefined();
    expect(single).toBeDefined();
    expect(cross!.sources.length).toBeGreaterThan(single!.sources.length);
    expect(cross!.score).toBeGreaterThan(single!.score);
  });

  it('generates a markdown briefing and optionally saves a note', async () => {
    const now = Date.now();
    mocked.fetchRssFeed.mockResolvedValue({
      title: 'feed',
      link: 'http://example.com',
      description: '',
      entries: [
        {
          id: '1',
          title: 'Daily Paper One',
          link: 'http://arxiv.org/abs/1',
          summary: 'Summary one.',
          authors: ['A'],
          publishedAt: now,
          categories: ['cs.AI'],
        },
      ],
    });

    const result = await generateDailyPapersBriefing({ categories: ['cs.AI'], maxResults: 5, saveNote: true });
    expect(result.papers).toHaveLength(1);
    expect(result.markdown).toContain('# Daily Papers Briefing');
    expect(result.markdown).toContain('Daily Paper One');
    expect(result.noteId).toMatch(/^daily-papers-/);
  });
});
