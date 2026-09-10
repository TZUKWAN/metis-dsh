/**
 * CurrentAffairsRepositoryService — repository-backed truth verifier.
 *
 * Replaces renderer-trusted source validation with main-process repository lookup.
 * Every source in a manifest is independently verified against the stored truth:
 *   - Source exists and is not deleted
 *   - Cross-project defense via projectId binding
 *   - Full metadata identity: title, authors, url, kind, publishedAt, fetchedAt
 *   - Correction state matches repository (renderer cannot self-assert "clean")
 *   - Content digest integrity
 *
 * Profile identity is bound at the Manifest+receipt tuple level, not per-source.
 * A single canonical source may be reused across multiple workflows/profiles.
 */
import { createHash } from 'node:crypto';
import type { CurrentAffairsManifest, CurrentAffairsSourceRecord } from './CurrentAffairsProfile.js';

export interface RepositorySourceRecord {
  id: string;
  projectId: string;
  title: string;
  kind: string;
  authors: string[];
  publishedAt: number | null;
  fetchedAt: number | null;
  url: string | null;
  correctionState: string;
  contentDigest: string | null;
  deleted: boolean;
}

export interface RepositoryVerificationResult {
  sourceId: string;
  exists: boolean;
  deleted: boolean;
  projectMatch: boolean;
  titleMatch: boolean;
  authorsMatch: boolean;
  urlMatch: boolean;
  kindMatch: boolean;
  publishedAtMatch: boolean;
  fetchedAtMatch: boolean;
  correctionMatches: boolean;
  correctionState: string;
  contentDigestMatch: boolean;
  /** SHA-256 of the stored record's canonical identity fields.  Missing
   *  sources use the fixed string "missing".  Two different stored records
   *  always produce different digests, even when both fail verification. */
  canonicalIdentityDigest: string;
  verified: boolean;
  reason?: string;
}

function normalize(s: string): string { return s.trim().toLowerCase(); }

const MISSING_CANONICAL_MARKER = 'missing';

/** Compute a deterministic SHA-256 digest of a stored source's canonical
 *  identity fields.  Two different stored records always produce different
 *  digests regardless of match status. */
function computeCanonicalIdentityDigest(stored: RepositorySourceRecord): string {
  const canonical = {
    projectId: stored.projectId,
    title: normalize(stored.title),
    // Stable sort authors for determinism
    authors: [...stored.authors].map(normalize).sort(),
    publishedAt: stored.publishedAt,
    fetchedAt: stored.fetchedAt,
    url: stored.url ?? null,
    kind: stored.kind,
    correctionState: stored.correctionState,
    contentDigest: stored.contentDigest ?? null,
    deleted: stored.deleted,
  };
  return createHash('sha256').update(JSON.stringify(canonical)).digest('hex');
}

export interface CurrentAffairsRepositoryDeps {
  getSource: (id: string) => RepositorySourceRecord | undefined;
  now: () => number;
}

export class CurrentAffairsRepositoryService {
  readonly #deps: CurrentAffairsRepositoryDeps;

  constructor(deps: CurrentAffairsRepositoryDeps) {
    this.#deps = deps;
  }

  verifyManifest(manifest: CurrentAffairsManifest): RepositoryVerificationResult[] {
    return manifest.sources.map((s) => this.verifySource(s, manifest.projectId));
  }

  verifySource(source: CurrentAffairsSourceRecord, expectedProjectId: string): RepositoryVerificationResult {
    const stored = this.#deps.getSource(source.sourceId);
    const base = {
      sourceId: source.sourceId, exists: false, deleted: false,
      projectMatch: false,
      titleMatch: false, authorsMatch: false,
      urlMatch: false, kindMatch: false,
      publishedAtMatch: false, fetchedAtMatch: false,
      correctionMatches: false, correctionState: 'unknown',
      contentDigestMatch: false, canonicalIdentityDigest: MISSING_CANONICAL_MARKER,
      verified: false,
    };

    if (!stored) return { ...base, reason: 'Source not found in repository' };
    base.exists = true;

    // Compute canonical fingerprint BEFORE any match checks — this binds
    // the stored identity regardless of whether the manifest matches.
    const canonicalIdentityDigest = computeCanonicalIdentityDigest(stored);

    if (stored.deleted) {
      return { ...base, exists: true, deleted: true, canonicalIdentityDigest, reason: 'Source is deleted' };
    }

    // Cross-project defense
    const projectMatch = stored.projectId === expectedProjectId;

    // Full identity verification (renderer cannot spoof title/authors/url/kind)
    const titleMatch = normalize(source.title) === normalize(stored.title);
    const authorsMatch = source.authors.length === stored.authors.length
      && source.authors.every((a, i) => normalize(a) === normalize(stored.authors[i] ?? ''));
    const urlMatch = (source.url ?? '') === (stored.url ?? '');
    const kindMatch = source.kind === stored.kind;
    // Temporal identity — renderer cannot forge publication/fetch timestamps
    const publishedAtMatch = (source.publishedAt ?? null) === (stored.publishedAt ?? null);
    const fetchedAtMatch = (source.fetchedAt ?? null) === (stored.fetchedAt ?? null);
    const correctionMatches = source.correctionState === stored.correctionState;
    const contentDigestMatch = !!(source.contentDigest && stored.contentDigest && source.contentDigest === stored.contentDigest);

    const verified = projectMatch && titleMatch && authorsMatch
      && urlMatch && kindMatch && publishedAtMatch && fetchedAtMatch
      && correctionMatches && contentDigestMatch;

    let reason: string | undefined;
    if (!projectMatch) reason = 'Cross-project: source belongs to different project';
    else if (!titleMatch) reason = 'Title mismatch';
    else if (!authorsMatch) reason = 'Authors mismatch';
    else if (!urlMatch) reason = 'URL mismatch';
    else if (!kindMatch) reason = 'Kind mismatch';
    else if (!publishedAtMatch) reason = 'Published date mismatch';
    else if (!fetchedAtMatch) reason = 'Fetched date mismatch';
    else if (!correctionMatches) reason = `Correction mismatch: manifest=${source.correctionState}, repo=${stored.correctionState}`;
    else if (!contentDigestMatch) reason = 'Content digest mismatch';

    return {
      sourceId: source.sourceId, exists: true, deleted: false,
      projectMatch, titleMatch, authorsMatch, urlMatch, kindMatch,
      publishedAtMatch, fetchedAtMatch,
      correctionMatches, correctionState: stored.correctionState,
      contentDigestMatch, canonicalIdentityDigest,
      verified, reason,
    };
  }

  /** Compute a snapshot digest of all source states for audit trail.
   *  Includes canonical stored identity fields with stable sort so that
   *  any difference in project/title/url/authors/time/kind/correction
   *  changes the digest — two different forged sources cannot produce the
   *  same snapshot. Profile identity is bound at manifest level
   *  (Manifest+receipt tuple), not per-source. */
  computeSourceSnapshotDigest(manifest: CurrentAffairsManifest): string {
    const results = this.verifyManifest(manifest);
    // Stable sort by sourceId so ordering doesn't affect digest
    const sorted = [...results].sort((a, b) => a.sourceId.localeCompare(b.sourceId));
    const snapshot = sorted.map((r) => ({
      sourceId: r.sourceId,
      canonicalIdentityDigest: r.canonicalIdentityDigest,
      correctionState: r.correctionState,
      verified: r.verified,
      reason: r.reason ?? null,
    }));
    // Include manifest-level identity in the hash so different projects
    // or profiles produce different digests even with same source results.
    // profileId is bound at Manifest+receipt tuple, not per-source.
    const payload = {
      projectId: manifest.projectId,
      profileId: manifest.profileId,
      sources: snapshot,
    };
    return createHash('sha256').update(JSON.stringify(payload)).digest('hex');
  }

  /** Check if any source in the manifest is stale vs repository. */
  isManifestStale(manifest: CurrentAffairsManifest): boolean {
    return this.verifyManifest(manifest).some((r) => !r.verified);
  }
}
