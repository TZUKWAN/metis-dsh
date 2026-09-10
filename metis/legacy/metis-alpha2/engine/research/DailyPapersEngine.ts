/**
 * Daily Papers Engine — tracks recent submissions from arXiv, bioRxiv, and
 * medRxiv by category and produces a ranked daily briefing.
 *
 * Inspired by Claude Scholar's `daily-paper-generator` workflow, which
 * surfaces top papers from arXiv / bioRxiv and narrows them down through
 * a Top-N → Top-M → Top-1 funnel.
 *
 * This deterministic engine uses RSS feeds, scores papers by recency,
 * keyword relevance, and cross-source buzz, and outputs a Markdown briefing
 * that can optionally be saved as a note.
 */

import { fetchRssFeed, type RssFeedEntry } from './RssFeedResolver.js';
import { NoteManager } from './NoteManager.js';

// ─── Types ──────────────────────────────────────────────────

export interface DailyPaper {
  id: string;
  title: string;
  authors: string[];
  link: string;
  summary: string;
  categories: string[];
  sources: string[];
  publishedAt?: number;
  score: number;
}

export interface DailyPapersResult {
  date: string;
  categories: string[];
  totalFetched: number;
  papers: DailyPaper[];
  markdown: string;
  noteId?: string;
}

// ─── Configuration ──────────────────────────────────────────

type Source = 'arxiv' | 'biorxiv' | 'medrxiv';

const RSS_BASES: Record<Source, string> = {
  arxiv: 'http://export.arxiv.org/rss',
  biorxiv: 'https://www.biorxiv.org/rss',
  medrxiv: 'https://www.medrxiv.org/rss',
};

const DEFAULT_CATEGORIES = ['arxiv:cs.AI', 'arxiv:cs.CL', 'arxiv:cs.CV', 'arxiv:cs.LG'];

const SOURCE_ALIASES: Record<string, Source> = {
  arxiv: 'arxiv',
  biorxiv: 'biorxiv',
  bio: 'biorxiv',
  medrxiv: 'medrxiv',
  med: 'medrxiv',
};

const CATEGORY_ALIASES: Record<string, string> = {
  ai: 'cs.AI',
  nlp: 'cs.CL',
  cv: 'cs.CV',
  ml: 'cs.LG',
  'machine learning': 'cs.LG',
  'computer vision': 'cs.CV',
  'natural language processing': 'cs.CL',
  'artificial intelligence': 'cs.AI',
};

interface ParsedCategory {
  source: Source;
  category: string;
  raw: string;
}

function parseCategory(input: string): ParsedCategory {
  const trimmed = input.trim();
  const parts = trimmed.split(':');
  if (parts.length >= 2) {
    const sourceKey = parts[0]!.toLowerCase();
    const source = SOURCE_ALIASES[sourceKey];
    if (source) {
      const category = parts.slice(1).join(':');
      return { source, category: normalizeCategoryPart(category), raw: trimmed };
    }
  }
  return { source: 'arxiv', category: normalizeCategoryPart(trimmed), raw: trimmed };
}

function normalizeCategoryPart(category: string): string {
  const trimmed = category.trim();
  const lower = trimmed.toLowerCase();
  return CATEGORY_ALIASES[lower] ?? trimmed;
}

// ─── Fetching ───────────────────────────────────────────────

export async function fetchCategoryRss(category: string): Promise<Array<RssFeedEntry & { source: Source }>> {
  const { source, category: normalized } = parseCategory(category);
  const url = `${RSS_BASES[source]}/${normalized}`;
  const feed = await fetchRssFeed(url, 15000);
  if (!feed) return [];
  return feed.entries.map((entry) => ({
    ...entry,
    categories: [...entry.categories, normalized],
    source,
  }));
}

export interface FetchDailyPapersResult {
  papers: DailyPaper[];
  totalFetched: number;
}

export async function fetchDailyPapers(
  categories: string[] = DEFAULT_CATEGORIES,
  options: { maxResults?: number; keywords?: string[] } = {},
): Promise<FetchDailyPapersResult> {
  const maxResults = Math.min(Math.max(options.maxResults ?? 20, 1), 100);
  const keywords = (options.keywords ?? []).map((k) => k.toLowerCase());

  const entriesArrays = await Promise.all(categories.map(fetchCategoryRss));
  const allEntries = entriesArrays.flat();
  const totalFetched = allEntries.length;

  // Group by link to detect cross-source buzz.
  const byLink = new Map<string, Array<RssFeedEntry & { source: Source }>>();
  for (const entry of allEntries) {
    const list = byLink.get(entry.link) ?? [];
    list.push(entry);
    byLink.set(entry.link, list);
  }

  const now = Date.now();
  const oneDay = 24 * 60 * 60 * 1000;

  const scored: DailyPaper[] = [];
  for (const [link, entries] of byLink) {
    const representative = entries[0]!;
    const allCategories = [...new Set(entries.flatMap((e) => e.categories))];
    const allSources = [...new Set(entries.map((e) => e.source))];

    let score = 0;

    // Recency: higher for papers published within last 24h, decay for older.
    const ageMs = representative.publishedAt ? now - representative.publishedAt : Number.MAX_SAFE_INTEGER;
    if (ageMs <= oneDay) score += 30;
    else if (ageMs <= oneDay * 3) score += 15;
    else if (ageMs <= oneDay * 7) score += 5;

    // Keyword relevance.
    const text = `${representative.title} ${representative.summary}`.toLowerCase();
    for (const keyword of keywords) {
      const count = text.split(keyword).length - 1;
      score += count * 10;
    }

    // Cross-source buzz: a paper appearing in multiple feeds is trending.
    if (allSources.length > 1) score += 20;
    if (entries.length > 1) score += (entries.length - 1) * 5;

    // Slight preference for entries with authors.
    if (representative.authors.length > 0) score += 2;

    scored.push({
      id: representative.id,
      title: representative.title,
      authors: representative.authors,
      link,
      summary: representative.summary,
      categories: allCategories,
      sources: allSources,
      publishedAt: representative.publishedAt,
      score,
    });
  }

  const papers = scored.sort((a, b) => b.score - a.score).slice(0, maxResults);
  return { papers, totalFetched };
}

// ─── Briefing generation ────────────────────────────────────

function formatDate(timestamp: number): string {
  return new Date(timestamp).toISOString().split('T')[0]!;
}

function renderMarkdown(result: DailyPapersResult): string {
  const lines: string[] = [
    `# Daily Papers Briefing — ${result.date}`,
    '',
    `**Categories**: ${result.categories.join(', ')}`,
    `**Fetched**: ${result.totalFetched} papers`,
    `**Highlighted**: ${result.papers.length}`,
    '',
    '## Top Papers',
    '',
  ];

  if (result.papers.length === 0) {
    lines.push('No papers found for the selected categories.');
    lines.push('');
  } else {
    for (let i = 0; i < result.papers.length; i++) {
      const paper = result.papers[i]!;
      lines.push(`### ${i + 1}. ${paper.title}`);
      lines.push(`- **Authors**: ${paper.authors.join(', ') || 'Unknown'}`);
      lines.push(`- **Sources**: ${paper.sources.join(', ')}`);
      lines.push(`- **Categories**: ${paper.categories.join(', ')}`);
      if (paper.publishedAt) {
        lines.push(`- **Published**: ${formatDate(paper.publishedAt)}`);
      }
      lines.push(`- **Link**: ${paper.link}`);
      lines.push(`- **Score**: ${paper.score}`);
      lines.push('');
      lines.push(paper.summary || 'No abstract available.');
      lines.push('');
    }
  }

  return lines.join('\n');
}

// ─── Top-level entry point ──────────────────────────────────

export async function generateDailyPapersBriefing(
  options: {
    categories?: string[];
    maxResults?: number;
    keywords?: string[];
    saveNote?: boolean;
  } = {},
): Promise<DailyPapersResult> {
  const parsedCategories = (options.categories ?? DEFAULT_CATEGORIES).map(parseCategory);
  const categories = parsedCategories.map((p) => p.raw);
  const { papers, totalFetched } = await fetchDailyPapers(categories, {
    maxResults: options.maxResults,
    keywords: options.keywords,
  });

  const result: DailyPapersResult = {
    date: formatDate(Date.now()),
    categories,
    totalFetched,
    papers,
    markdown: '',
  };

  result.markdown = renderMarkdown(result);

  if (options.saveNote) {
    const nm = new NoteManager();
    const note = nm.save({
      id: `daily-papers-${Date.now()}`,
      title: `Daily Papers — ${result.date}`,
      content: result.markdown,
      tags: ['daily-papers', ...new Set(result.papers.flatMap((p) => p.sources)), ...categories],
      linkedPaperIds: [],
      linkedNoteIds: [],
    });
    result.noteId = note.id;
  }

  return result;
}

export function dailyPapersToPlain(result: DailyPapersResult): Record<string, unknown> {
  return {
    date: result.date,
    categories: result.categories,
    totalFetched: result.totalFetched,
    paperCount: result.papers.length,
    papers: result.papers.map((p) => ({
      title: p.title,
      authors: p.authors,
      link: p.link,
      sources: p.sources,
      categories: p.categories,
      publishedAt: p.publishedAt,
      score: p.score,
    })),
    noteId: result.noteId,
  };
}
