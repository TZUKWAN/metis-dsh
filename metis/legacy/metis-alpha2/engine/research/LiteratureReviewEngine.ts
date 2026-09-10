/**
 * Literature Review Engine — synthesizes a set of papers into a structured review.
 *
 * Compared to RelatedWorkGenerator (which only reads the local paper library tags),
 * this engine:
 *   - fetches papers by query or identifiers from external indexes,
 *   - clusters papers by extracted keywords,
 *   - surfaces methodological conflicts and research gaps,
 *   - reports temporal/venue/author trends,
 *   - outputs a publication-style markdown review.
 *
 * Inspired by claude-scholar's `literature-reviewer` agent and the literature-review workflow,
 * but implemented as a deterministic, testable engine without external LLM calls.
 */

import {
  searchPapers,
  getPaperRecommendations,
  getPaperById,
  type SemanticScholarPaper,
  type CitationEdge,
} from './SemanticScholarClient.js';
import { resolveDoi } from './DoiResolver.js';
import { resolveArxiv } from './ArxivResolver.js';
import { NoteManager } from './NoteManager.js';

// ─── Types ──────────────────────────────────────────────────

export interface ReviewPaper {
  id: string;
  title: string;
  authors: string[];
  year: number;
  venue?: string;
  abstract: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  citationCount?: number;
}

export interface LiteratureCluster {
  name: string;
  keywords: string[];
  papers: ReviewPaper[];
  summary: string;
}

export interface ConflictSignal {
  type: 'finding' | 'method';
  paperA: string;
  paperB: string;
  description: string;
}

export interface LiteratureReviewResult {
  query: string;
  papers: ReviewPaper[];
  clusters: LiteratureCluster[];
  conflicts: ConflictSignal[];
  gaps: string[];
  trends: {
    yearHistogram: Record<number, number>;
    topVenues: Array<{ venue: string; count: number }>;
    topAuthors: Array<{ author: string; count: number }>;
  };
  networkStats: {
    seeds: number;
    expanded: number;
  };
  references: string[];
  markdown: string;
  noteId?: string;
}

// ─── Stopwords (basic English academic) ─────────────────────

const STOPWORDS = new Set([
  'the', 'a', 'an', 'and', 'or', 'but', 'in', 'on', 'at', 'to', 'for', 'of', 'with', 'by', 'from',
  'as', 'is', 'are', 'was', 'were', 'be', 'been', 'being', 'have', 'has', 'had', 'do', 'does', 'did',
  'will', 'would', 'could', 'should', 'may', 'might', 'can', 'this', 'that', 'these', 'those', 'we',
  'our', 'us', 'i', 'you', 'they', 'them', 'their', 'it', 'its', 'paper', 'study', 'work', 'propose',
  'proposed', 'show', 'shows', 'shown', 'using', 'use', 'used', 'based', 'approach', 'method', 'methods',
  'model', 'models', 'results', 'result', 'experiments', 'experimental', 'evaluation', 'evaluated',
  'demonstrate', 'demonstrates', 'novel', 'new', 'existing', 'recent', 'state', 'art', 'et', 'al',
]);

// ─── Keyword extraction ─────────────────────────────────────

function tokenize(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\s]/g, ' ')
    .split(/\s+/)
    .filter((w) => w.length >= 4 && !STOPWORDS.has(w));
}

function extractKeywords(text: string, limit = 10): string[] {
  const counts = new Map<string, number>();
  for (const word of tokenize(text)) {
    counts.set(word, (counts.get(word) ?? 0) + 1);
  }
  return [...counts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, limit)
    .map(([w]) => w);
}

function topGlobalKeywords(papers: ReviewPaper[], limit = 15): string[] {
  const counts = new Map<string, number>();
  for (const paper of papers) {
    for (const kw of extractKeywords(`${paper.title} ${paper.abstract}`, 20)) {
      counts.set(kw, (counts.get(kw) ?? 0) + 1);
    }
  }
  const sorted = [...counts.entries()].sort((a, b) => b[1] - a[1]);
  const frequent = sorted.filter(([, count]) => count >= 2);
  const source = frequent.length > 0 ? frequent : sorted;
  return source.slice(0, limit).map(([w]) => w);
}

// ─── Clustering ─────────────────────────────────────────────

export function clusterPapers(papers: ReviewPaper[], clusterCount = 4): LiteratureCluster[] {
  if (papers.length === 0) return [];

  const keywords = topGlobalKeywords(papers, clusterCount * 3);
  const count = Math.max(1, Math.min(clusterCount, keywords.length));

  // Pick cluster centers as evenly spaced top keywords.
  const centers: string[][] = [];
  for (let i = 0; i < count; i++) {
    const start = Math.floor((i * keywords.length) / count);
    const end = Math.floor(((i + 1) * keywords.length) / count);
    centers.push(keywords.slice(start, Math.max(start + 1, end)));
  }

  const assignments: number[] = papers.map(() => -1);
  for (let iter = 0; iter < 5; iter++) {
    let changed = false;
    for (let p = 0; p < papers.length; p++) {
      const paper = papers[p]!;
      const paperKws = new Set(extractKeywords(`${paper.title} ${paper.abstract}`, 25));
      let best = 0;
      let bestScore = -1;
      for (let c = 0; c < centers.length; c++) {
        const score = centers[c]!.filter((k) => paperKws.has(k)).length;
        if (score > bestScore) {
          bestScore = score;
          best = c;
        }
      }
      if (assignments[p] !== best) {
        assignments[p] = best;
        changed = true;
      }
    }
    if (!changed) break;

    // Recompute centers as the most frequent keywords in each cluster.
    for (let c = 0; c < centers.length; c++) {
      const clusterPapers = papers.filter((_, i) => assignments[i] === c);
      if (clusterPapers.length === 0) continue;
      const kwCounts = new Map<string, number>();
      for (const paper of clusterPapers) {
        for (const kw of extractKeywords(`${paper.title} ${paper.abstract}`, 20)) {
          kwCounts.set(kw, (kwCounts.get(kw) ?? 0) + 1);
        }
      }
      centers[c] = [...kwCounts.entries()]
        .sort((a, b) => b[1] - a[1])
        .slice(0, 5)
        .map(([w]) => w);
      if (centers[c]!.length === 0) centers[c] = [`cluster_${c + 1}`];
    }
  }

  const clusters: LiteratureCluster[] = [];
  for (let c = 0; c < centers.length; c++) {
    const clusterPapers = papers.filter((_, i) => assignments[i] === c);
    if (clusterPapers.length === 0) continue;
    const name = centers[c]![0] ?? `theme_${c + 1}`;
    clusters.push({
      name,
      keywords: centers[c]!,
      papers: clusterPapers,
      summary: makeClusterSummary(clusterPapers, name),
    });
  }

  return clusters.sort((a, b) => b.papers.length - a.papers.length);
}

function makeClusterSummary(papers: ReviewPaper[], theme: string): string {
  if (papers.length === 0) return '';
  const years = papers.map((p) => p.year).filter((y) => y > 0);
  const yearRange = years.length > 0 ? `${Math.min(...years)}–${Math.max(...years)}` : 'unknown years';
  const venues = [...new Set(papers.map((p) => p.venue).filter(Boolean))].slice(0, 2).join(', ');
  const firstSentence = papers[0]!.abstract.split(/\.\s+/)[0]?.trim() ?? '';
  return `This cluster on "${theme}" spans ${yearRange}${venues ? ` and appears in ${venues}` : ''}. ${firstSentence}.`;
}

// ─── Conflict detection ─────────────────────────────────────

const NEGATION_PHRASES = ['not improve', 'does not', 'do not', 'no evidence', 'not outperform', 'not effective', 'contradict', 'challenge', 'unlike', 'not consistent'];
const POSITIVE_PHRASES = ['improve', 'outperform', 'achieve', 'effective', 'superior', 'better than', 'enhance'];

export function detectConflicts(papers: ReviewPaper[]): ConflictSignal[] {
  const conflicts: ConflictSignal[] = [];
  const textOf = (p: ReviewPaper) => `${p.title} ${p.abstract}`.toLowerCase();

  for (let i = 0; i < papers.length; i++) {
    for (let j = i + 1; j < papers.length; j++) {
      const a = papers[i]!;
      const b = papers[j]!;
      const ta = textOf(a);
      const tb = textOf(b);
      const aNeg = NEGATION_PHRASES.some((ph) => ta.includes(ph));
      const bPos = POSITIVE_PHRASES.some((ph) => tb.includes(ph));
      const bNeg = NEGATION_PHRASES.some((ph) => tb.includes(ph));
      const aPos = POSITIVE_PHRASES.some((ph) => ta.includes(ph));

      // Shared keywords to make conflict meaningful.
      const kwsA = new Set(extractKeywords(`${a.title} ${a.abstract}`, 15));
      const kwsB = new Set(extractKeywords(`${b.title} ${b.abstract}`, 15));
      const shared = [...kwsA].filter((k) => kwsB.has(k));
      if (shared.length === 0) continue;

      if ((aNeg && bPos) || (bNeg && aPos)) {
        conflicts.push({
          type: 'finding',
          paperA: a.title,
          paperB: b.title,
          description: `Potential conflict around "${shared.slice(0, 3).join(', ')}" — one study reports a negative/null result while the other reports a positive outcome.`,
        });
      }
    }
  }

  return conflicts.slice(0, 5);
}

// ─── Gap detection ──────────────────────────────────────────

export function detectGaps(papers: ReviewPaper[], query: string): string[] {
  const gaps: string[] = [];
  if (papers.length === 0) return gaps;

  const clusters = clusterPapers(papers, 4);
  for (const cluster of clusters) {
    if (cluster.papers.length === 1) {
      gaps.push(`Only one paper addresses "${cluster.name}"; more evidence is needed to establish this sub-theme.`);
    }
  }

  const queryTerms = tokenize(query);
  const allKws = new Set<string>();
  for (const paper of papers) {
    for (const kw of extractKeywords(`${paper.title} ${paper.abstract}`, 25)) allKws.add(kw);
  }
  for (const term of queryTerms) {
    if (!allKws.has(term)) {
      gaps.push(`Few papers explicitly address "${term}" from the query; consider targeted search.`);
    }
  }

  const years = papers.map((p) => p.year).filter((y) => y > 0).sort((a, b) => a - b);
  if (years.length > 0) {
    const recent = years[years.length - 1]!;
    const now = new Date().getFullYear();
    if (now - recent >= 2) {
      gaps.push(`The most recent included paper is from ${recent}; the literature may have progressed since then.`);
    }
  }

  const venues = new Map<string, number>();
  for (const paper of papers) {
    if (paper.venue) venues.set(paper.venue, (venues.get(paper.venue) ?? 0) + 1);
  }
  if (venues.size <= 1 && papers.length > 3) {
    gaps.push(`Papers are concentrated in a single venue; cross-venue validation would strengthen the review.`);
  }

  return gaps.slice(0, 6);
}

// ─── Trends ─────────────────────────────────────────────────

export function analyzeTrends(papers: ReviewPaper[]) {
  const yearHistogram: Record<number, number> = {};
  const venueCounts = new Map<string, number>();
  const authorCounts = new Map<string, number>();

  for (const paper of papers) {
    if (paper.year > 0) {
      yearHistogram[paper.year] = (yearHistogram[paper.year] ?? 0) + 1;
    }
    if (paper.venue) {
      venueCounts.set(paper.venue, (venueCounts.get(paper.venue) ?? 0) + 1);
    }
    for (const author of paper.authors.slice(0, 5)) {
      authorCounts.set(author, (authorCounts.get(author) ?? 0) + 1);
    }
  }

  const topVenues = [...venueCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([venue, count]) => ({ venue, count }));

  const topAuthors = [...authorCounts.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, 5)
    .map(([author, count]) => ({ author, count }));

  return { yearHistogram, topVenues, topAuthors };
}

// ─── Citation network expansion ─────────────────────────────

function citationEdgeToReviewPaper(edge: CitationEdge, relation: 'citation' | 'reference'): ReviewPaper {
  return {
    id: edge.paperId ?? `${relation}-${edge.title ?? 'unknown'}`,
    title: edge.title ?? 'Untitled',
    authors: (edge.authors ?? []).map((a) => a.name),
    year: edge.year ?? 0,
    venue: edge.venue,
    abstract: '',
    doi: edge.externalIds?.DOI,
    arxivId: edge.externalIds?.ArXiv,
    url: edge.url,
    citationCount: edge.citationCount,
  };
}

async function tryEnrichAbstract(paper: ReviewPaper): Promise<ReviewPaper> {
  if (paper.abstract.trim()) return paper;

  // Try Semantic Scholar paper details for expanded network papers.
  if (paper.id.startsWith('semantic-scholar:')) {
    const paperId = paper.id.replace('semantic-scholar:', '');
    try {
      const detail = await getPaperById({ paperId });
      if (detail?.abstract) return { ...paper, abstract: detail.abstract };
    } catch { /* ignore */ }
  }

  // Fallback to arXiv abstract for seed papers with an arXiv ID.
  if (paper.arxivId) {
    try {
      const detail = await resolveArxiv(paper.arxivId);
      if (detail?.abstract) return { ...paper, abstract: detail.abstract };
    } catch { /* ignore */ }
  }

  // Fallback to DOI abstract for seed papers with a DOI.
  if (paper.doi) {
    try {
      const detail = await resolveDoi(paper.doi);
      if (detail?.abstract) return { ...paper, abstract: detail.abstract };
    } catch { /* ignore */ }
  }

  return paper;
}

async function enrichAbstracts(papers: ReviewPaper[], concurrency = 5): Promise<ReviewPaper[]> {
  const results: ReviewPaper[] = [];
  for (let i = 0; i < papers.length; i += concurrency) {
    const chunk = papers.slice(i, i + concurrency);
    const enriched = await Promise.all(chunk.map(tryEnrichAbstract));
    results.push(...enriched);
  }
  return results;
}

function normalizeSemanticScholarPaperId(id: string): string {
  const trimmed = id.trim().replace(/^semantic-scholar:/i, '');
  if (/^10\./.test(trimmed)) return `DOI:${trimmed}`;
  if (/\d{4}\.\d{4,5}/.test(trimmed)) return `ARXIV:${trimmed}`;
  return trimmed;
}

export async function expandByCitationNetwork(
  seedIds: string[],
  options: { maxPerSeed?: number; maxTotal?: number } = {},
): Promise<ReviewPaper[]> {
  const maxPerSeed = Math.min(Math.max(options.maxPerSeed ?? 5, 1), 20);
  const maxTotal = options.maxTotal ?? seedIds.length * maxPerSeed * 2;
  const expanded: ReviewPaper[] = [];
  const seen = new Set<string>();

  for (const seedId of seedIds.slice(0, 5).map(normalizeSemanticScholarPaperId)) {
    try {
      const [citations, references] = await Promise.all([
        getPaperRecommendations({ paperId: seedId, type: 'citations', limit: maxPerSeed }),
        getPaperRecommendations({ paperId: seedId, type: 'references', limit: maxPerSeed }),
      ]);

      for (const edge of citations.data) {
        const paper = edge.citingPaper;
        if (!paper || !paper.paperId || seen.has(paper.paperId)) continue;
        seen.add(paper.paperId);
        expanded.push({ ...citationEdgeToReviewPaper(paper, 'citation'), id: `semantic-scholar:${paper.paperId}` });
      }
      for (const edge of references.data) {
        const paper = edge.citedPaper;
        if (!paper || !paper.paperId || seen.has(paper.paperId)) continue;
        seen.add(paper.paperId);
        expanded.push({ ...citationEdgeToReviewPaper(paper, 'reference'), id: `semantic-scholar:${paper.paperId}` });
      }
    } catch {
      // Ignore network errors for individual seeds.
    }
    if (expanded.length >= maxTotal) break;
  }

  const enriched = await enrichAbstracts(expanded.slice(0, maxTotal), 5);
  return enriched;
}

// ─── Paper fetching ─────────────────────────────────────────

export async function fetchPapersForReview(
  options: { query?: string; identifiers?: string[]; maxResults?: number },
): Promise<ReviewPaper[]> {
  const { query, identifiers, maxResults = 10 } = options;
  const papers: ReviewPaper[] = [];
  const seen = new Set<string>();

  function add(p?: ReviewPaper | null) {
    if (!p) return;
    const key = p.doi ?? p.arxivId ?? p.id;
    if (seen.has(key)) return;
    seen.add(key);
    papers.push(p);
  }

  if (identifiers && identifiers.length > 0) {
    for (const id of identifiers.slice(0, maxResults)) {
      const trimmed = id.trim();
      const lower = trimmed.toLowerCase();
      const doiCandidate = lower.startsWith('doi:') ? trimmed.slice(4) : trimmed;
      const arxivCandidate = lower.startsWith('arxiv:') ? trimmed.slice(6) : trimmed;

      if (doiCandidate.startsWith('10.')) {
        const meta = await resolveDoi(doiCandidate);
        if (meta) {
          add({
            id: `doi:${meta.doi}`,
            title: meta.title,
            authors: meta.authors,
            year: meta.year,
            venue: meta.venue,
            abstract: meta.abstract,
            doi: meta.doi,
            url: meta.url,
            citationCount: meta.citationCount,
          });
        }
      } else if (/\d{4}\.\d{4,5}/.test(arxivCandidate)) {
        const meta = await resolveArxiv(arxivCandidate);
        if (meta) {
          add({
            id: `arxiv:${meta.arxivId}`,
            title: meta.title,
            authors: meta.authors,
            year: meta.year,
            venue: 'arXiv',
            abstract: meta.abstract,
            arxivId: meta.arxivId,
            url: meta.url,
          });
        }
      } else {
        // Treat anything else as a Semantic Scholar paper ID (with optional prefix).
        const paperId = trimmed.replace(/^semantic-scholar:/i, '');
        try {
          const paper = await getPaperById({ paperId });
          if (paper) add(semanticScholarToReviewPaper(paper));
        } catch {
          // Ignore unresolved paper IDs.
        }
      }
    }
  }

  if (query && query.trim() && papers.length < maxResults) {
    try {
      const result = await searchPapers({ query: query.trim(), limit: maxResults - papers.length });
      for (const p of result.data) {
        add(semanticScholarToReviewPaper(p));
      }
    } catch {
      // Fall back to whatever we already have.
    }
  }

  return papers.slice(0, maxResults);
}

function semanticScholarToReviewPaper(p: SemanticScholarPaper): ReviewPaper {
  return {
    id: p.paperId,
    title: p.title,
    authors: p.authors?.map((a) => a.name) ?? [],
    year: p.year ?? 0,
    venue: p.venue,
    abstract: p.abstract ?? '',
    doi: p.externalIds?.DOI,
    arxivId: p.externalIds?.ArXiv,
    url: p.url,
    citationCount: p.citationCount,
  };
}

// ─── Review building ────────────────────────────────────────

export function buildLiteratureReview(
  papers: ReviewPaper[],
  query: string,
  options: { saveNote?: boolean; noteManager?: NoteManager; networkStats?: LiteratureReviewResult['networkStats'] } = {},
): LiteratureReviewResult {
  const clusters = clusterPapers(papers, 4);
  const conflicts = detectConflicts(papers);
  const gaps = detectGaps(papers, query);
  const trends = analyzeTrends(papers);

  const references = papers.map((p) => {
    const authors = p.authors.slice(0, 3).join(', ') + (p.authors.length > 3 ? ' et al.' : '');
    return `${authors} (${p.year}). ${p.title}${p.venue ? `. ${p.venue}` : ''}${p.doi ? `. https://doi.org/${p.doi}` : ''}`;
  });

  const markdown = renderMarkdown({
    query,
    papers,
    clusters,
    conflicts,
    gaps,
    trends,
    references,
    networkStats: options.networkStats,
  });

  let noteId: string | undefined;
  if (options.saveNote) {
    const nm = options.noteManager ?? new NoteManager();
    const note = nm.save({
      id: `literature-review-${Date.now()}`,
      title: `Literature Review: ${query || 'Untitled'}`,
      content: markdown,
      tags: ['literature-review', 'auto-generated'],
      linkedPaperIds: papers.map((p) => p.id),
      linkedNoteIds: [],
    });
    noteId = note.id;
  }

  return {
    query,
    papers,
    clusters,
    conflicts,
    gaps,
    trends,
    networkStats: options.networkStats ?? { seeds: papers.length, expanded: 0 },
    references,
    markdown,
    noteId,
  };
}

function renderMarkdown(data: {
  query: string;
  papers: ReviewPaper[];
  clusters: LiteratureCluster[];
  conflicts: ConflictSignal[];
  gaps: string[];
  trends: LiteratureReviewResult['trends'];
  references: string[];
  networkStats?: LiteratureReviewResult['networkStats'];
}): string {
  const lines: string[] = [
    `# Literature Review: ${data.query || 'Untitled'}`,
    '',
    `**Papers reviewed**: ${data.papers.length}`,
    `**Themes identified**: ${data.clusters.length}`,
    `**Potential conflicts**: ${data.conflicts.length}`,
    `**Research gaps flagged**: ${data.gaps.length}`,
    ...(data.networkStats ? [`**Network**: ${data.networkStats.seeds} seeds + ${data.networkStats.expanded} expanded`] : []),
    '',
    '## Overview',
    '',
    data.papers.length === 0
      ? 'No papers were found for the given query or identifiers.'
      : `This review synthesizes ${data.papers.length} papers on "${data.query}". The papers are grouped into ${data.clusters.length} thematic clusters, and key conflicts, gaps, and trends are highlighted below.`,
    '',
  ];

  if (data.clusters.length > 0) {
    lines.push('## Thematic Clusters', '');
    for (const cluster of data.clusters) {
      lines.push(`### ${cluster.name}`);
      lines.push(`**Keywords**: ${cluster.keywords.join(', ')}`);
      lines.push(`**Papers**: ${cluster.papers.length}`);
      lines.push('');
      lines.push(cluster.summary);
      lines.push('');
      for (const paper of cluster.papers.slice(0, 5)) {
        const author = paper.authors[0]?.split(' ').pop() ?? 'Unknown';
        lines.push(`- ${author} et al. (${paper.year}) — ${paper.title}`);
      }
      if (cluster.papers.length > 5) {
        lines.push(`- ... and ${cluster.papers.length - 5} more`);
      }
      lines.push('');
    }
  }

  if (data.conflicts.length > 0) {
    lines.push('## Potential Conflicts', '');
    for (const conflict of data.conflicts) {
      lines.push(`- **${conflict.paperA}** vs **${conflict.paperB}**`);
      lines.push(`  - ${conflict.description}`);
    }
    lines.push('');
  }

  if (data.gaps.length > 0) {
    lines.push('## Research Gaps', '');
    for (const gap of data.gaps) {
      lines.push(`- ${gap}`);
    }
    lines.push('');
  }

  lines.push('## Trends', '');
  const years = Object.entries(data.trends.yearHistogram).sort(([a], [b]) => Number(a) - Number(b));
  if (years.length > 0) {
    lines.push('### Publication years');
    for (const [year, count] of years) {
      lines.push(`- ${year}: ${count}`);
    }
    lines.push('');
  }
  if (data.trends.topVenues.length > 0) {
    lines.push('### Top venues');
    for (const { venue, count } of data.trends.topVenues) {
      lines.push(`- ${venue}: ${count}`);
    }
    lines.push('');
  }
  if (data.trends.topAuthors.length > 0) {
    lines.push('### Prolific authors');
    for (const { author, count } of data.trends.topAuthors) {
      lines.push(`- ${author}: ${count}`);
    }
    lines.push('');
  }

  if (data.references.length > 0) {
    lines.push('## References', '');
    for (let i = 0; i < data.references.length; i++) {
      lines.push(`${i + 1}. ${data.references[i]}`);
    }
    lines.push('');
  }

  return lines.join('\n');
}

// ─── Top-level entry point ──────────────────────────────────

export async function generateLiteratureReview(
  options: {
    query?: string;
    identifiers?: string[];
    maxResults?: number;
    saveNote?: boolean;
    expandNetwork?: boolean;
  },
): Promise<LiteratureReviewResult> {
  const query = options.query ?? (options.identifiers ? `identifiers: ${options.identifiers.join(', ')}` : '');
  const maxResults = options.maxResults ?? 10;
  const seeds = await fetchPapersForReview({
    query: options.query,
    identifiers: options.identifiers,
    maxResults,
  });

  const enrichedSeeds = await enrichAbstracts(seeds, 5);

  let expanded: ReviewPaper[] = [];
  if (options.expandNetwork && options.identifiers && options.identifiers.length > 0) {
    expanded = await expandByCitationNetwork(options.identifiers, {
      maxPerSeed: 5,
      maxTotal: Math.max(5, maxResults - seeds.length),
    });
  }

  // Merge seeds and expanded, keeping seeds first.
  const seen = new Set<string>();
  const papers: ReviewPaper[] = [];
  for (const p of [...enrichedSeeds, ...expanded]) {
    const key = p.doi ?? p.arxivId ?? p.id;
    if (seen.has(key)) continue;
    seen.add(key);
    papers.push(p);
  }

  return buildLiteratureReview(papers, query, {
    saveNote: options.saveNote,
    networkStats: { seeds: seeds.length, expanded: expanded.length },
  });
}

export function literatureReviewToPlain(result: LiteratureReviewResult): Record<string, unknown> {
  return {
    query: result.query,
    paperCount: result.papers.length,
    clusters: result.clusters.map((c) => ({
      name: c.name,
      keywords: c.keywords,
      paperCount: c.papers.length,
      summary: c.summary,
    })),
    conflicts: result.conflicts,
    gaps: result.gaps,
    trends: result.trends,
    networkStats: result.networkStats,
    noteId: result.noteId,
  };
}
