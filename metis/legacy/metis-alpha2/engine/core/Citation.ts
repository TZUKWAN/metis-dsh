/**
 * Citation type for AI answer provenance (O8).
 *
 * A Citation links a piece of an AI answer to a concrete source: a paper in
 * the library, a specific page/quote, or an external URL. The ChatPage renders
 * citations as clickable references that open the source. This closes the gap
 * with AnythingLLM's source-citations / PrivateGPT's "retrieval with
 * citations": research answers must be traceable, not trust-me.
 *
 * Citations ride on ChatMessage.metadata (key 'citations') so existing message
 * schemas, persistence, and provider round-trips are unchanged.
 */

export interface Citation {
  /** Stable id within a message, e.g. "1", "2" — used as the visible marker. */
  id: string;
  /** Library paper id when the source is a collected paper. */
  paperId?: string;
  /** DOI when known (opens doi.org or the local library match). */
  doi?: string;
  /** External URL for non-library sources. */
  url?: string;
  /** Human-readable label (title or domain) shown in the citation chip. */
  label: string;
  /** Optional page number or locator inside a PDF. */
  page?: number;
  /** Optional verbatim quote from the source. */
  quote?: string;
}

/** Metadata key under which citations are stored on a ChatMessage. */
export const CITATIONS_METADATA_KEY = 'citations';

/** Type guard: does a metadata blob carry citations? */
export function hasCitations(metadata: unknown): metadata is { [CITATIONS_METADATA_KEY]: Citation[] } {
  if (!metadata || typeof metadata !== 'object') return false;
  const obj = metadata as Record<string, unknown>;
  return Array.isArray(obj[CITATIONS_METADATA_KEY]) && (obj[CITATIONS_METADATA_KEY] as unknown[]).length > 0;
}

/** Extract citations from a ChatMessage metadata blob, or return []. */
export function extractCitations(metadata: unknown): Citation[] {
  if (!hasCitations(metadata)) return [];
  return metadata[CITATIONS_METADATA_KEY];
}

/**
 * Extract DOI-based citations from answer text. Each unique DOI becomes one
 * citation chip; the label is the DOI itself (short, unambiguous). This gives
 * the UI traceable source links even when the agent did not explicitly tag
 * citations — closing the gap with AnythingLLM's automatic source references.
 * Caller merges these with any explicit metadata citations.
 */
export function extractDoiCitations(text: string): Citation[] {
  if (!text) return [];
  const seen = new Set<string>();
  const citations: Citation[] = [];
  const pattern = /10\.\d{4,9}\/[-._;()/:A-Z0-9]+/gi;
  let match: RegExpExecArray | null;
  let index = 1;
  while ((match = pattern.exec(text)) !== null) {
    const doi = match[0].replace(/[.,;)]+$/u, '');
    const key = doi.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    citations.push({ id: String(index++), doi, label: doi });
  }
  return citations;
}
