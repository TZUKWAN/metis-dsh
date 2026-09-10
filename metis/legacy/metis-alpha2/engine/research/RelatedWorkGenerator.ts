/**
 * Related Work Generator — scans paper library and auto-generates
 * structured related-work paragraphs with citations.
 *
 * Groups papers by topic, recommends key citations for each topic,
 * and produces draft Related Work text ready for academic papers.
 */

import type { PaperItem } from './PaperItem.js';

// ─── Types ──────────────────────────────────────────────────

export interface TopicCluster {
  topic: string;
  papers: PaperItem[];
  keyPaper: PaperItem;
  otherPapers: PaperItem[];
}

export interface RelatedWorkSection {
  topic: string;
  text: string;
  citations: string[];
}

export interface RelatedWorkResult {
  sections: RelatedWorkSection[];
  fullText: string;
  totalPapers: number;
  totalTopics: number;
}

// ─── Topic Clustering (tag-based) ───────────────────────────

function clusterByTags(papers: PaperItem[]): TopicCluster[] {
  const tagMap = new Map<string, PaperItem[]>();

  for (const paper of papers) {
    for (const tag of paper.tags) {
      if (!tagMap.has(tag)) tagMap.set(tag, []);
      tagMap.get(tag)!.push(paper);
    }
  }

  // Keep clusters with at least 2 papers
  const clusters: TopicCluster[] = [];
  for (const [topic, ps] of tagMap) {
    if (ps.length < 2) continue;
    const sorted = ps.sort((a, b) => b.rating - a.rating || b.year - a.year);
    clusters.push({
      topic,
      papers: sorted,
      keyPaper: sorted[0]!,
      otherPapers: sorted.slice(1),
    });
  }

  return clusters.sort((a, b) => b.papers.length - a.papers.length).slice(0, 5);
}

// ─── Citation Formatting ────────────────────────────────────

function formatCitation(paper: PaperItem): string {
  const author = paper.authors[0]?.split(' ').pop() ?? 'Unknown';
  return `${author} et al. (${paper.year})`;
}

function formatBibtexRef(_paper: PaperItem, index: number): string {
  return `[${index}]`;
}

// ─── Related Work Generator ─────────────────────────────────

export class RelatedWorkGenerator {
  /**
   * Generate Related Work sections from the paper library.
   */
  generate(papers: PaperItem[]): RelatedWorkResult {
    if (papers.length === 0) {
      return { sections: [], fullText: 'No papers in library to generate related work.', totalPapers: 0, totalTopics: 0 };
    }

    const clusters = clusterByTags(papers);
    const sections: RelatedWorkSection[] = [];
    let refIndex = 0;
    let fullText = '## Related Work\n\n';

    for (const cluster of clusters) {
      refIndex++;
      const citations: string[] = [];

      // Key paper description
      const keyCitation = formatCitation(cluster.keyPaper);
      const keyRef = formatBibtexRef(cluster.keyPaper, refIndex);
      citations.push(keyCitation);

      let text = `**${cluster.topic}**. ${keyCitation} ${keyRef} `;
      text += cluster.keyPaper.abstract.slice(0, 120).replace(/\n/g, ' ');

      // Other papers in cluster
      if (cluster.otherPapers.length > 0) {
        let otherText = ' Related work includes ';
        const otherRefs: string[] = [];
        for (const other of cluster.otherPapers.slice(0, 3)) {
          refIndex++;
          const c = formatCitation(other);
          const ref = formatBibtexRef(other, refIndex);
          citations.push(c);
          otherRefs.push(`${c} ${ref}`);
        }
        otherText += otherRefs.join(', ') + '.';
        text += otherText;
      }

      text += `\\n\\n`;

      sections.push({ topic: cluster.topic, text, citations });
      fullText += text;
    }

    fullText += `\\n*Auto-generated from ${papers.length} papers in the Metis library.*`;

    return {
      sections,
      fullText: fullText.replace(/\\n/g, '\n'),
      totalPapers: papers.length,
      totalTopics: sections.length,
    };
  }

  /**
   * Get recommended citations for a specific topic/query.
   */
  recommendForTopic(papers: PaperItem[], topic: string, count = 5): PaperItem[] {
    const q = topic.toLowerCase();
    const scored = papers
      .map((p) => {
        let score = 0;
        if (p.title.toLowerCase().includes(q)) score += 3;
        if (p.abstract.toLowerCase().includes(q)) score += 2;
        for (const tag of p.tags) {
          if (tag.toLowerCase().includes(q)) score += 2;
        }
        if (p.venue?.toLowerCase().includes(q)) score += 1;
        score += p.rating * 0.5;
        return { paper: p, score };
      })
      .filter(({ score }) => score > 0)
      .sort((a, b) => b.score - a.score);

    return scored.slice(0, count).map(({ paper }) => paper);
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: RelatedWorkGenerator | null = null;

export function getRelatedWorkGenerator(): RelatedWorkGenerator {
  if (!_instance) _instance = new RelatedWorkGenerator();
  return _instance;
}
