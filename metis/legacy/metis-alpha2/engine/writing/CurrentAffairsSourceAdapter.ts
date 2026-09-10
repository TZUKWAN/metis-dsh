/**
 * CurrentAffairsSourceAdapter — maps ResearchRepository Source to CA RepositorySourceRecord.
 *
 * Tags-based kind resolution: Research Source.tags containing "current-affairs:<kind>"
 * are the sole authority. Renderer kind is never trusted.
 *
 * Mappings:
 *   sourceVersionHash → contentDigest
 *   metadata.caCorrectionState → correctionState (strict enum, missing=fail-closed)
 *   metadata.publishedAt → publishedAt (explicit, null if missing)
 *   metadata.fetchedAt → fetchedAt (explicit, fallback to createdAt)
 *   source.updatedAt → updatedAt (explicit)
 *   deletedAt !== null → deleted: true
 *   projectId from source.projectId
 *
 * Missing/ambiguous/illegal → fail-closed (returns null).
 */
import type { Source } from '../persistence/researchModel.js';

export const VALID_CA_KINDS = [
  'policy_document', 'official_statistics', 'authoritative_news',
  'legislative_record', 'regulatory_filing', 'expert_testimony', 'institutional_report',
] as const;

export type CAKind = typeof VALID_CA_KINDS[number];

const TAG_PREFIX = 'current-affairs:';

const VALID_CORRECTION_STATES = ['clean', 'correction_pending', 'corrected', 'retracted'] as const;

/** Extract CA kind from source tags. Returns null if missing/ambiguous/illegal. */
function extractCAKind(tags: string[] | null | undefined): CAKind | null {
  if (!tags || tags.length === 0) return null;
  const matches = tags.filter(t => t.startsWith(TAG_PREFIX)).map(t => t.slice(TAG_PREFIX.length));
  const unique = [...new Set(matches)];
  if (unique.length !== 1) return null; // ambiguous → fail
  if (!VALID_CA_KINDS.includes(unique[0] as CAKind)) return null; // illegal → fail
  return unique[0] as CAKind;
}

/**
 * Extract correction state from metadata.caCorrectionState.
 * Returns null if missing or illegal — never defaults to 'clean'.
 */
function extractCorrectionState(metadata: Record<string, unknown> | null | undefined): string | null {
  if (!metadata || typeof metadata.caCorrectionState !== 'string') return null;
  if (!VALID_CORRECTION_STATES.includes(metadata.caCorrectionState as typeof VALID_CORRECTION_STATES[number])) return null;
  return metadata.caCorrectionState;
}

function extractOptionalNumber(metadata: Record<string, unknown> | null | undefined, key: string): number | null {
  if (!metadata) return null;
  const v = metadata[key];
  return typeof v === 'number' && Number.isFinite(v) && v >= 0 ? v : null;
}

export interface AdaptedSource {
  id: string;
  projectId: string;
  title: string;
  kind: string;
  authors: string[];
  publishedAt: number | null;
  fetchedAt: number | null;
  updatedAt: number;
  url: string | null;
  correctionState: string;
  contentDigest: string | null;
  deleted: boolean;
}

/**
 * Adapt a Research Source to CA RepositorySourceRecord.
 * Returns null if required CA kind cannot be resolved or correctionState is missing/illegal (fail-closed).
 */
export function adaptSource(source: Source): AdaptedSource | null {
  const kind = extractCAKind(source.tags);
  if (!kind) return null;

  const metadata = source.metadata as Record<string, unknown> | null;
  const correctionState = extractCorrectionState(metadata);
  if (!correctionState) return null;

  return {
    id: source.id,
    projectId: source.projectId ?? '',
    title: source.title,
    kind,
    authors: source.authors ?? [],
    publishedAt: extractOptionalNumber(metadata, 'publishedAt'),
    fetchedAt: extractOptionalNumber(metadata, 'fetchedAt') ?? source.createdAt,
    updatedAt: source.updatedAt,
    url: source.externalUrl ?? null,
    correctionState,
    contentDigest: source.sourceVersionHash ?? null,
    deleted: source.deletedAt !== null,
  };
}
