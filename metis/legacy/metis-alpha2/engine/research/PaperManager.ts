/**
 * Paper Manager — manages research paper metadata, collections, and BibTeX import/export.
 */

export type ReadStatus = 'unread' | 'reading' | 'read' | 'skimmed';

export interface Paper {
  id: string;
  title: string;
  authors: string[];
  year: number;
  venue: string;
  abstract: string;
  doi?: string;
  arxivId?: string;
  url?: string;
  pdfPath?: string;
  tags: string[];
  notes: string;
  readStatus: ReadStatus;
  rating: number; // 1-5
  citationCount?: number;
  bibtexKey?: string;
  addedAt: number;
  updatedAt: number;
}

export interface PaperCollection {
  id: string;
  name: string;
  description: string;
  paperIds: string[];
  createdAt: number;
}

export class PaperManager {
  private readonly papers = new Map<string, Paper>();
  private readonly collections = new Map<string, PaperCollection>();

  /** Add or update a paper. */
  addPaper(paper: Omit<Paper, 'addedAt' | 'updatedAt'>): Paper {
    const existing = this.papers.get(paper.id);
    const now = Date.now();
    const entry: Paper = {
      ...paper,
      addedAt: existing?.addedAt ?? now,
      updatedAt: now,
    };
    this.papers.set(paper.id, entry);
    return entry;
  }

  /** Get a paper by ID. */
  getPaper(id: string): Paper | undefined {
    return this.papers.get(id);
  }

  /** Get a paper by arXiv ID. */
  getByArxivId(arxivId: string): Paper | undefined {
    return [...this.papers.values()].find((p) => p.arxivId === arxivId);
  }

  /** Remove a paper. */
  removePaper(id: string): boolean {
    for (const col of this.collections.values()) {
      col.paperIds = col.paperIds.filter((pid) => pid !== id);
    }
    return this.papers.delete(id);
  }

  /** Search papers by title, authors, abstract, venue, or tags. */
  search(query: string): Paper[] {
    const lower = query.toLowerCase();
    return [...this.papers.values()].filter((p) => {
      return (
        p.title.toLowerCase().includes(lower) ||
        p.authors.some((a) => a.toLowerCase().includes(lower)) ||
        p.abstract.toLowerCase().includes(lower) ||
        p.venue.toLowerCase().includes(lower) ||
        p.tags.some((t) => t.toLowerCase().includes(lower))
      );
    });
  }

  /** Filter papers by year range, rating, read status, or tags. */
  filter(options: {
    yearFrom?: number; yearTo?: number; minRating?: number;
    tags?: string[]; readStatus?: ReadStatus; venue?: string;
  }): Paper[] {
    let results = [...this.papers.values()];
    if (options.yearFrom !== undefined) results = results.filter((p) => p.year >= options.yearFrom!);
    if (options.yearTo !== undefined) results = results.filter((p) => p.year <= options.yearTo!);
    if (options.minRating !== undefined) results = results.filter((p) => p.rating >= options.minRating!);
    if (options.readStatus) results = results.filter((p) => p.readStatus === options.readStatus);
    if (options.venue) results = results.filter((p) => p.venue.toLowerCase().includes(options.venue!.toLowerCase()));
    if (options.tags && options.tags.length > 0) {
      results = results.filter((p) => options.tags!.some((t) => p.tags.includes(t)));
    }
    return results;
  }

  /** Mark paper read status. */
  setReadStatus(id: string, status: ReadStatus): boolean {
    const p = this.papers.get(id);
    if (!p) return false;
    p.readStatus = status;
    p.updatedAt = Date.now();
    return true;
  }

  /** Export paper as BibTeX entry. */
  exportBibtex(id: string): string | undefined {
    const p = this.papers.get(id);
    if (!p) return undefined;
    const key = p.bibtexKey ?? `${p.authors[0]?.split(' ').pop()?.toLowerCase() ?? 'author'}${p.year}`;
    return [
      `@article{${key},`,
      `  title = {${p.title}},`,
      `  author = {${p.authors.join(' and ')}},`,
      `  year = {${p.year}},`,
      p.venue ? `  journal = {${p.venue}},` : '',
      p.doi ? `  doi = {${p.doi}},` : '',
      p.url ? `  url = {${p.url}},` : '',
      '}',
    ].filter(Boolean).join('\n');
  }

  /** Import paper from BibTeX-like structured data. */
  importFromBibtex(bibData: {
    title: string; authors: string[]; year: number;
    venue?: string; doi?: string; arxivId?: string; abstract?: string;
  }): Paper {
    const id = `paper_${Date.now()}_${Math.random().toString(36).slice(2, 6)}`;
    return this.addPaper({
      id,
      title: bibData.title,
      authors: bibData.authors,
      year: bibData.year,
      venue: bibData.venue ?? '',
      abstract: bibData.abstract ?? '',
      doi: bibData.doi,
      arxivId: bibData.arxivId,
      tags: [],
      notes: '',
      readStatus: 'unread',
      rating: 0,
    });
  }

  // ── Collections ─────────────────────────────────────────

  createCollection(id: string, name: string, description = ''): PaperCollection {
    const col: PaperCollection = { id, name, description, paperIds: [], createdAt: Date.now() };
    this.collections.set(id, col);
    return col;
  }

  addToCollection(collectionId: string, paperId: string): boolean {
    const col = this.collections.get(collectionId);
    if (!col || !this.papers.has(paperId)) return false;
    if (!col.paperIds.includes(paperId)) col.paperIds.push(paperId);
    return true;
  }

  getCollectionPapers(collectionId: string): Paper[] {
    const col = this.collections.get(collectionId);
    if (!col) return [];
    return col.paperIds.map((id) => this.papers.get(id)).filter(Boolean) as Paper[];
  }

  listCollections(): PaperCollection[] {
    return [...this.collections.values()];
  }

  // ── Stats ────────────────────────────────────────────────

  /** Get paper statistics grouped by read status. */
  getStats(): { total: number; byStatus: Record<ReadStatus, number>; byYear: Record<number, number>; avgRating: number } {
    const papers = [...this.papers.values()];
    const byStatus: Record<ReadStatus, number> = { unread: 0, reading: 0, read: 0, skimmed: 0 };
    const byYear: Record<number, number> = {};
    let totalRating = 0;
    let ratedCount = 0;

    for (const p of papers) {
      byStatus[p.readStatus] = (byStatus[p.readStatus] ?? 0) + 1;
      byYear[p.year] = (byYear[p.year] ?? 0) + 1;
      if (p.rating > 0) { totalRating += p.rating; ratedCount++; }
    }

    return {
      total: papers.length,
      byStatus,
      byYear,
      avgRating: ratedCount > 0 ? Math.round((totalRating / ratedCount) * 10) / 10 : 0,
    };
  }

  get paperCount(): number { return this.papers.size; }
  get collectionCount(): number { return this.collections.size; }
}
