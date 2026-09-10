/**
 * RAG Engine — Retrieval-Augmented Generation for paper Q&A.
 *
 * Provides local vector storage and semantic search over the paper library.
 * Uses lightweight TF-IDF + cosine similarity (no external embedding API required).
 * Designed for glm-4.7-flash compatibility — works entirely locally.
 *
 * Features:
 *   - Index papers by title, abstract, and full text
 *   - Semantic search with configurable top-k
 *   - Query-time relevance ranking
 *   - Paper chunking for long documents
 */

import type { PaperItem } from './PaperItem.js';

// ─── Types ──────────────────────────────────────────────────

export interface RagDocument {
  /** Unique document ID (paper ID) */
  id: string;
  /** Document title */
  title: string;
  /** Full text content to index */
  content: string;
  /** Metadata for filtering */
  metadata: {
    authors?: string[];
    year?: number;
    venue?: string;
    tags?: string[];
  };
}

export interface RagSearchResult {
  document: RagDocument;
  score: number;
  /** Relevant text snippet */
  snippet: string;
}

export interface RagIndexStats {
  documentCount: number;
  vocabularySize: number;
  totalTokens: number;
}

// ─── TF-IDF Vectorizer ─────────────────────────────────────

interface TfIdfWeights {
  /** Map of term → document frequency (number of docs containing term) */
  docFreq: Map<string, number>;
  /** Map of docId → Map of term → TF-IDF weight */
  vectors: Map<string, Map<string, number>>;
  /** Total number of documents */
  docCount: number;
  /** Stop words (filtered out) */
  stopWords: Set<string>;
}

const STOP_WORDS = new Set([
  'the', 'a', 'an', 'is', 'are', 'was', 'were', 'be', 'been', 'being',
  'have', 'has', 'had', 'do', 'does', 'did', 'will', 'would', 'could',
  'should', 'may', 'might', 'shall', 'can', 'need', 'dare', 'ought',
  'used', 'to', 'of', 'in', 'for', 'on', 'with', 'at', 'by', 'from',
  'as', 'into', 'through', 'during', 'before', 'after', 'above', 'below',
  'between', 'out', 'off', 'over', 'under', 'again', 'further', 'then',
  'once', 'here', 'there', 'when', 'where', 'why', 'how', 'all', 'both',
  'each', 'few', 'more', 'most', 'other', 'some', 'such', 'no', 'nor',
  'not', 'only', 'own', 'same', 'so', 'than', 'too', 'very', 'just',
  'about', 'also', 'but', 'and', 'or', 'if', 'while', 'that', 'this',
  'it', 'its', 'he', 'she', 'they', 'them', 'their', 'we', 'you', 'i',
]);

function tokenize(text: string, stopWords: Set<string>): string[] {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9\u4e00-\u9fff\s]/g, ' ')
    .split(/\s+/)
    .filter((t) => t.length > 1 && !stopWords.has(t));
}

function buildTfIdf(docs: RagDocument[]): TfIdfWeights {
  const docFreq = new Map<string, number>();
  const vectors = new Map<string, Map<string, number>>();

  // First pass: count document frequencies
  for (const doc of docs) {
    const terms = new Set(tokenize(doc.content, STOP_WORDS));
    for (const term of terms) {
      docFreq.set(term, (docFreq.get(term) ?? 0) + 1);
    }
  }

  // Second pass: compute TF-IDF vectors
  for (const doc of docs) {
    const tokens = tokenize(doc.content, STOP_WORDS);
    const tf = new Map<string, number>();
    for (const t of tokens) {
      tf.set(t, (tf.get(t) ?? 0) + 1);
    }

    const vector = new Map<string, number>();
    for (const [term, count] of tf) {
      // Smoothed IDF: +1 keeps weights non-zero even when every document
      // contains the term (or there is a single document), so cosine search
      // still ranks correctly for small libraries.
      const idf = 1 + Math.log((docs.length + 1) / ((docFreq.get(term) ?? 0) + 1));
      vector.set(term, (count / tokens.length) * idf);
    }
    vectors.set(doc.id, vector);
  }

  return { docFreq, vectors, docCount: docs.length, stopWords: STOP_WORDS };
}

// ─── RAG Engine ────────────────────────────────────────────

export class RagEngine {
  private weights: TfIdfWeights | null = null;
  private documents = new Map<string, RagDocument>();

  /** Index a single document. */
  indexDocument(doc: RagDocument): void {
    this.documents.set(doc.id, doc);
    this.weights = null; // Invalidate cache
  }

  /** Index multiple documents at once. */
  indexDocuments(docs: RagDocument[]): void {
    for (const doc of docs) {
      this.documents.set(doc.id, doc);
    }
    this.weights = null; // Invalidate cache
  }

  /** Build or rebuild the TF-IDF index. */
  private getWeights(): TfIdfWeights {
    if (!this.weights) {
      this.weights = buildTfIdf([...this.documents.values()]);
    }
    return this.weights;
  }

  /** Remove a document from the index. */
  removeDocument(id: string): boolean {
    const deleted = this.documents.delete(id);
    if (deleted) this.weights = null;
    return deleted;
  }

  /** Get index statistics. */
  stats(): RagIndexStats {
    const weights = this.getWeights();
    return {
      documentCount: weights.docCount,
      vocabularySize: weights.docFreq.size,
      totalTokens: [...weights.vectors.values()].reduce(
        (sum, v) => sum + v.size, 0,
      ),
    };
  }

  /**
   * Search the index for documents relevant to a query.
   * Returns top-k results ranked by cosine similarity.
   */
  search(query: string, topK = 5): RagSearchResult[] {
    const weights = this.getWeights();
    if (weights.docCount === 0) return [];

    // Tokenize query
    const queryTokens = tokenize(query, weights.stopWords);
    const queryTf = new Map<string, number>();
    for (const t of queryTokens) {
      queryTf.set(t, (queryTf.get(t) ?? 0) + 1);
    }

    // Build query vector (smoothed IDF, matching the index-side formula).
    const queryVec = new Map<string, number>();
    for (const [term, count] of queryTf) {
      const idf = 1 + Math.log(
        (weights.docCount + 1) / ((weights.docFreq.get(term) ?? 0) + 1),
      );
      queryVec.set(term, (count / queryTokens.length) * idf);
    }

    // Compute cosine similarity against all documents
    const scores: Array<{ docId: string; score: number }> = [];
    for (const [docId, docVec] of weights.vectors) {
      let dotProduct = 0;
      let queryNorm = 0;
      let docNorm = 0;

      for (const [term, qWeight] of queryVec) {
        const dWeight = docVec.get(term) ?? 0;
        dotProduct += qWeight * dWeight;
        queryNorm += qWeight * qWeight;
        docNorm += dWeight * dWeight;
      }

      queryNorm = Math.sqrt(queryNorm);
      docNorm = Math.sqrt(docNorm);

      const score = queryNorm > 0 && docNorm > 0
        ? dotProduct / (queryNorm * docNorm)
        : 0;

      if (score > 0) {
        scores.push({ docId, score });
      }
    }

    // Sort by score descending, take top-K
    scores.sort((a, b) => b.score - a.score);
    const top = scores.slice(0, topK);

    return top.map(({ docId, score }) => {
      const doc = this.documents.get(docId)!;
      const snippet = this.generateSnippet(doc.content, queryTokens);
      return { document: doc, score, snippet };
    });
  }

  /**
   * Generate a snippet from document content relevant to query tokens.
   */
  private generateSnippet(content: string, queryTokens: string[], maxLen = 200): string {
    const lowerContent = content.toLowerCase();
    let bestPos = 0;
    let bestScore = 0;

    for (const token of queryTokens) {
      const pos = lowerContent.indexOf(token);
      if (pos === -1) continue;
      const contextStart = Math.max(0, pos - 60);
      const contextEnd = Math.min(content.length, pos + token.length + 60);
      const context = content.slice(contextStart, contextEnd);
      let score = 0;
      for (const t of queryTokens) {
        if (context.toLowerCase().includes(t)) score++;
      }
      if (score > bestScore) {
        bestScore = score;
        bestPos = contextStart;
      }
    }

    let snippet = content.slice(bestPos, bestPos + maxLen);
    if (bestPos > 0) snippet = '...' + snippet;
    if (bestPos + maxLen < content.length) snippet = snippet + '...';
    return snippet;
  }

  /**
   * Convert PaperItem array to RagDocuments and index them.
   */
  indexPapers(papers: PaperItem[]): void {
    const docs: RagDocument[] = papers.map((p) => ({
      id: p.id,
      title: p.title,
      content: `${p.title}\n${p.abstract}\n${p.notes}`,
      metadata: {
        authors: p.authors,
        year: p.year,
        venue: p.venue,
        tags: p.tags,
      },
    }));
    this.indexDocuments(docs);
  }

  /**
   * Index papers including their full PDF text (when extracted). The full
   * text is appended after title/abstract/notes and capped per paper so a
   * single huge document does not dominate the TF-IDF vocabulary; PDFs without
   * extracted text fall back to the standard fields.
   */
  indexPapersWithFullText(papers: PaperItem[], fullTextCap = 80_000): void {
    const docs: RagDocument[] = papers.map((p) => {
      const fullText = (p.pdfText ?? '').trim();
      const content = fullText
        ? `${p.title}\n${p.abstract}\n${p.notes}\n${fullText.slice(0, fullTextCap)}`
        : `${p.title}\n${p.abstract}\n${p.notes}`;
      return {
        id: p.id,
        title: p.title,
        content,
        metadata: {
          authors: p.authors,
          year: p.year,
          venue: p.venue,
          tags: p.tags,
        },
      };
    });
    this.indexDocuments(docs);
  }

  /**
   * Serialize the indexed documents for persistence (the index itself is
   * rebuilt lazily from documents on load, so only docs need to be stored).
   * Returns a JSON-safe representation of the document set.
   */
  serializeDocuments(): string {
    return JSON.stringify([...this.documents.values()]);
  }

  /**
   * Replace the document set from a previously persisted payload.
   * Returns the number of documents loaded.
   */
  loadSerializedDocuments(payload: string): number {
    try {
      const docs = JSON.parse(payload) as RagDocument[];
      this.documents.clear();
      for (const doc of docs) {
        if (doc && typeof doc.id === 'string' && typeof doc.content === 'string') {
          this.documents.set(doc.id, doc);
        }
      }
      this.weights = null;
      return this.documents.size;
    } catch {
      return 0;
    }
  }

  /**
   * Generate a context block for LLM from search results.
   */
  formatResultsForLLM(results: RagSearchResult[]): string {
    if (results.length === 0) return 'No relevant documents found.';

    return results
      .map(
        (r, i) =>
          `[${i + 1}] ${r.document.title} (relevance: ${(r.score * 100).toFixed(0)}%)\n` +
          `Authors: ${r.document.metadata.authors?.join(', ') ?? 'Unknown'}\n` +
          `Year: ${r.document.metadata.year ?? 'N/A'}\n` +
          `Snippet: ${r.snippet}\n`,
      )
      .join('\n');
  }
  /**
   * Semantic search using embedding API (OpenAI-compatible, e.g. GLM).
   * Falls back to TF-IDF if embedding API is unavailable or fails.
   * This solves "深度学习 matches not 神经网络" — embeddings capture semantic meaning.
   *
   * @param query - Natural language query
   * @param topK - Number of results
   * @param embeddingApiUrl - OpenAI-compatible embeddings endpoint (e.g., "https://open.bigmodel.cn/api/paas/v4/embeddings")
   * @param embeddingApiKey - API key for the embeddings endpoint
   * @param embeddingModel - Model name (default "embedding-2")
   */
  async searchWithEmbedding(
    query: string,
    topK = 5,
    embeddingApiUrl?: string,
    embeddingApiKey?: string,
    embeddingModel = 'embedding-2',
  ): Promise<RagSearchResult[]> {
    // If no API configured, fall back to TF-IDF
    if (!embeddingApiUrl || !embeddingApiKey) {
      return this.search(query, topK);
    }

    try {
      // Get query embedding
      const queryResp = await fetch(embeddingApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${embeddingApiKey}` },
        body: JSON.stringify({ model: embeddingModel, input: query }),
      });
      const queryJson = await queryResp.json() as { data?: Array<{ embedding?: number[] }> };
      const queryEmbedding = queryJson.data?.[0]?.embedding;
      if (!queryEmbedding || queryEmbedding.length === 0) {
        return this.search(query, topK); // Fallback
      }

      // Get document embeddings (batch or one-by-one)
      const docs = [...this.documents.values()];
      const docTexts = docs.map((d) => d.content.slice(0, 2000));

      const docResp = await fetch(embeddingApiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'Authorization': `Bearer ${embeddingApiKey}` },
        body: JSON.stringify({ model: embeddingModel, input: docTexts }),
      });
      const docJson = await docResp.json() as { data?: Array<{ embedding?: number[] }> };
      const docEmbeddings = docJson.data?.map((d) => d.embedding) ?? [];

      // Compute cosine similarity
      const scores: Array<{ docId: string; score: number }> = [];
      for (let i = 0; i < docs.length; i++) {
        const docEmb = docEmbeddings[i];
        if (!docEmb) continue;
        const similarity = this.cosineSimilarity(queryEmbedding, docEmb);
        if (similarity > 0) {
          scores.push({ docId: docs[i]!.id, score: similarity });
        }
      }

      scores.sort((a, b) => b.score - a.score);
      const top = scores.slice(0, topK);

      return top.map(({ docId, score }) => {
        const doc = this.documents.get(docId)!;
        const queryTokens = query.toLowerCase().split(/\s+/);
        const snippet = this.generateSnippet(doc.content, queryTokens);
        return { document: doc, score, snippet };
      });
    } catch {
      // Any error — fall back to TF-IDF
      return this.search(query, topK);
    }
  }

  /** Cosine similarity between two equal-length vectors. */
  private cosineSimilarity(a: number[], b: number[]): number {
    if (a.length !== b.length) return 0;
    let dot = 0, normA = 0, normB = 0;
    for (let i = 0; i < a.length; i++) {
      dot += a[i]! * b[i]!;
      normA += a[i]! * a[i]!;
      normB += b[i]! * b[i]!;
    }
    const denom = Math.sqrt(normA) * Math.sqrt(normB);
    return denom > 0 ? dot / denom : 0;
  }
}

// ─── Singleton ─────────────────────────────────────────────

let _instance: RagEngine | null = null;

export function getRagEngine(): RagEngine {
  if (!_instance) {
    _instance = new RagEngine();
  }
  return _instance;
}
