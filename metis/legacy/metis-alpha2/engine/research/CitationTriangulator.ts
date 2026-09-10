/**
 * Citation triangulation — cross-check a DOI across multiple bibliographic
 * indexes to detect hallucinated or inconsistent references.
 *
 * This is the first building block of the "anti-citation-hallucination /
 * Material Passport" capability found in advanced academic skill suites such
 * as ARS v3.8. It does not yet fetch cited passages, but it verifies that a
 * DOI exists and that key metadata (title, authors, year) is consistent
 * across independent sources.
 */

import { getWorkByDoi as getCrossrefWorkByDoi } from './CrossrefClient.js';
import { getWorkByDoi as getOpenAlexWorkByDoi } from './OpenAlexClient.js';
import { getPaperById } from './SemanticScholarClient.js';

export interface IndexRecord {
  index: 'crossref' | 'openalex' | 'semantic_scholar';
  found: boolean;
  doi?: string;
  title?: string;
  authors?: string[];
  year?: number;
  venue?: string;
  url?: string;
  error?: string;
}

export interface TriangulationResult {
  doi: string;
  normalizedDoi: string;
  existsIn: string[];
  missingIn: string[];
  titleConsensus: 'full' | 'partial' | 'none';
  yearConsensus: 'full' | 'partial' | 'none';
  authorConsensus: 'full' | 'partial' | 'none';
  overall: 'VERIFIED' | 'INCONSISTENT' | 'NOT_FOUND' | 'PARTIAL';
  records: IndexRecord[];
  warnings: string[];
}

function normalizeDoi(input: string): string {
  return input
    .trim()
    .replace(/^doi:\s*/i, '')
    .replace(/^https?:\/\/doi\.org\//i, '')
    .toLowerCase();
}

function normalizeTitle(title: string): string {
  return title.toLowerCase().replace(/[^a-z0-9]/g, '').trim();
}

function jaccardSimilarity(a: string[], b: string[]): number {
  const setA = new Set(a.map((s) => s.toLowerCase().trim()));
  const setB = new Set(b.map((s) => s.toLowerCase().trim()));
  if (setA.size === 0 && setB.size === 0) return 1;
  const intersection = new Set([...setA].filter((x) => setB.has(x)));
  const union = new Set([...setA, ...setB]);
  return union.size === 0 ? 0 : intersection.size / union.size;
}

function firstAuthorLastName(authors: string[] | undefined): string | undefined {
  if (!authors || authors.length === 0) return undefined;
  const parts = authors[0]!.split(/\s+/);
  return parts[parts.length - 1]?.toLowerCase();
}

function buildWarnings(exists: IndexRecord[]): string[] {
  const warnings: string[] = [];

  if (exists.length === 1) {
    warnings.push(`Only one index (${exists[0]!.index}) confirms this DOI; treat as provisional.`);
  }

  if (exists.length === 0) {
    warnings.push('This DOI was not found in any of the three indexes.');
  }

  // Title check
  const titles = exists.map((r) => r.title).filter((t): t is string => !!t);
  if (titles.length > 1) {
    const normalized = titles.map(normalizeTitle);
    const allSame = normalized.every((t) => t === normalized[0]);
    if (!allSame) {
      warnings.push('Title differs across indexes; possible metadata mismatch or preprint/journal version difference.');
    }
  }

  // Year check
  const years = exists.map((r) => r.year).filter((y): y is number => typeof y === 'number' && y > 0);
  if (years.length > 1) {
    const min = Math.min(...years);
    const max = Math.max(...years);
    if (max - min > 1) {
      warnings.push(`Year range across indexes is ${min}–${max}; verify the correct publication year.`);
    }
  }

  // Author check
  const firstAuthors = exists.map((r) => firstAuthorLastName(r.authors)).filter((a): a is string => !!a);
  if (firstAuthors.length > 1 && !firstAuthors.every((a) => a === firstAuthors[0])) {
    warnings.push('First author differs across indexes; verify author list.');
  }

  // Future year check
  const currentYear = new Date().getFullYear();
  for (const record of exists) {
    if (record.year && record.year > currentYear + 1) {
      warnings.push(`Year ${record.year} from ${record.index} is in the future.`);
    }
  }

  return warnings;
}

function computeConsensus<T>(records: IndexRecord[], getter: (r: IndexRecord) => T | undefined): 'full' | 'partial' | 'none' {
  const values = records.map(getter).filter((v): v is T => v !== undefined);
  if (values.length === 0) return 'none';
  if (values.length === 1) return 'partial';

  if (typeof values[0] === 'number') {
    const nums = values as number[];
    const min = Math.min(...nums);
    const max = Math.max(...nums);
    return max - min <= 1 ? 'full' : 'partial';
  }

  if (Array.isArray(values[0])) {
    const arrays = values as string[][];
    const similarity = arrays.every((arr) => jaccardSimilarity(arr, arrays[0]!) >= 0.5);
    return similarity ? 'full' : 'partial';
  }

  const strs = values as string[];
  const normalized = strs.map((s) => normalizeTitle(s));
  return normalized.every((s) => s === normalized[0]) ? 'full' : 'partial';
}

/**
 * Triangulate a DOI across Crossref, OpenAlex, and Semantic Scholar.
 */
export async function triangulateDoi(doi: string): Promise<TriangulationResult> {
  const normalizedDoi = normalizeDoi(doi);
  const records: IndexRecord[] = [];

  // Crossref
  try {
    const crossref = await getCrossrefWorkByDoi(normalizedDoi);
    records.push({
      index: 'crossref',
      found: !!crossref,
      doi: crossref?.doi,
      title: crossref?.title,
      authors: crossref?.authors,
      year: crossref?.year,
      venue: crossref?.venue,
      url: crossref?.url,
    });
  } catch (err) {
    records.push({ index: 'crossref', found: false, error: err instanceof Error ? err.message : String(err) });
  }

  // OpenAlex
  try {
    const openAlex = await getOpenAlexWorkByDoi(normalizedDoi);
    records.push({
      index: 'openalex',
      found: !!openAlex,
      doi: openAlex?.doi,
      title: openAlex?.title,
      authors: openAlex?.authors,
      year: openAlex?.year,
      venue: openAlex?.venue,
      url: openAlex?.url,
    });
  } catch (err) {
    records.push({ index: 'openalex', found: false, error: err instanceof Error ? err.message : String(err) });
  }

  // Semantic Scholar (DOI: prefix)
  try {
    const s2 = await getPaperById({ paperId: `DOI:${normalizedDoi}` });
    records.push({
      index: 'semantic_scholar',
      found: !!s2,
      doi: s2?.externalIds?.DOI,
      title: s2?.title,
      authors: s2?.authors?.map((a) => a.name),
      year: s2?.year,
      venue: s2?.venue,
      url: s2?.url,
    });
  } catch (err) {
    records.push({ index: 'semantic_scholar', found: false, error: err instanceof Error ? err.message : String(err) });
  }

  const exists = records.filter((r) => r.found);
  const missing = records.filter((r) => !r.found);

  const titleConsensus = computeConsensus(exists, (r) => r.title);
  const yearConsensus = computeConsensus(exists, (r) => r.year);
  const authorConsensus = computeConsensus(exists, (r) => r.authors);

  let overall: TriangulationResult['overall'];
  if (exists.length === 3 && titleConsensus === 'full' && yearConsensus === 'full' && authorConsensus === 'full') {
    overall = 'VERIFIED';
  } else if (exists.length === 0) {
    overall = 'NOT_FOUND';
  } else if (exists.length >= 2 && titleConsensus !== 'none' && yearConsensus !== 'none') {
    overall = titleConsensus === 'full' && yearConsensus === 'full' && authorConsensus === 'full' ? 'VERIFIED' : 'INCONSISTENT';
  } else {
    overall = 'PARTIAL';
  }

  const warnings = buildWarnings(exists);

  return {
    doi: normalizedDoi,
    normalizedDoi,
    existsIn: exists.map((r) => r.index),
    missingIn: missing.map((r) => r.index),
    titleConsensus,
    yearConsensus,
    authorConsensus,
    overall,
    records,
    warnings,
  };
}

/**
 * Convert a triangulation result into a plain object suitable for tool output.
 */
export function triangulationResultToPlain(result: TriangulationResult): Record<string, unknown> {
  return {
    doi: result.doi,
    existsIn: result.existsIn,
    missingIn: result.missingIn,
    titleConsensus: result.titleConsensus,
    yearConsensus: result.yearConsensus,
    authorConsensus: result.authorConsensus,
    overall: result.overall,
    warnings: result.warnings,
    records: result.records.map((r) => ({
      index: r.index,
      found: r.found,
      doi: r.doi,
      title: r.title,
      authors: r.authors,
      year: r.year,
      venue: r.venue,
      url: r.url,
      error: r.error,
    })),
  };
}
