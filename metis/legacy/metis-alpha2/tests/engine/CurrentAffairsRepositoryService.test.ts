/**
 * FIX-METIS-494: RepositoryService project + full metadata identity binding.
 * Red-test-first. Only touches CurrentAffairsRepositoryService + this file.
 * Does NOT touch main/preload/Panel/existing CA tests.
 *
 * Architecture: profileId is bound at Manifest+receipt tuple level, not per-source.
 * A canonical source may be reused across multiple workflows/profiles.
 */
import { describe, it, expect } from 'vitest';
import { CurrentAffairsRepositoryService } from '../../engine/writing/CurrentAffairsRepositoryService.js';
import type { RepositorySourceRecord } from '../../engine/writing/CurrentAffairsRepositoryService.js';
import type { CurrentAffairsManifest, CurrentAffairsSourceRecord } from '../../engine/writing/CurrentAffairsProfile.js';

// ── Helpers ─────────────────────────────────────────────────

function makeSource(overrides: Partial<CurrentAffairsSourceRecord> = {}): CurrentAffairsSourceRecord {
  return {
    sourceId: 'src-001',
    kind: 'policy_document',
    title: 'Test Source Title',
    authors: ['Author One'],
    publishedAt: 1700000000000,
    fetchedAt: 1700000000000,
    url: 'https://example.com/source',
    correctionState: 'clean',
    contentDigest: 'a'.repeat(64),
    ...overrides,
  };
}

function makeManifest(overrides: Partial<CurrentAffairsManifest> = {}): CurrentAffairsManifest {
  return {
    schemaVersion: 1,
    projectId: 'proj-001',
    workflowId: 'wf-001',
    profileId: 'profile-alice',
    manifestVersion: 3,
    title: 'Test Manifest',
    timeWindow: { fetchedAt: 1700000000000, timeSensitive: false },
    sources: [makeSource()],
    createdAt: 1700000000000,
    updatedAt: 1700000000000,
    ...overrides,
  };
}

function makeRepoSource(overrides: Partial<RepositorySourceRecord> = {}): RepositorySourceRecord {
  return {
    id: 'src-001',
    projectId: 'proj-001',
    title: 'Test Source Title',
    kind: 'policy_document',
    authors: ['Author One'],
    publishedAt: 1700000000000,
    fetchedAt: 1700000000000,
    url: 'https://example.com/source',
    correctionState: 'clean',
    contentDigest: 'a'.repeat(64),
    deleted: false,
    ...overrides,
  };
}

function repoWith(sources: RepositorySourceRecord[]) {
  const map = new Map(sources.map(s => [s.id, s]));
  return {
    getSource: (id: string) => map.get(id),
    now: () => 1700000000000,
  };
}

// ── Project identity ─────────────────────────────────────────

describe('FIX-494: project identity binding', () => {
  it('projectId mismatch fails verification', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ projectId: 'proj-002' }),
    ]));
    const manifest = makeManifest({ projectId: 'proj-001' });
    const results = svc.verifyManifest(manifest);
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.projectMatch).toBe(false);
    expect(results[0]!.reason).toBe('Cross-project: source belongs to different project');
  });

  it('projectId match + all identity → verified', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource()]));
    const manifest = makeManifest();
    const results = svc.verifyManifest(manifest);
    expect(results[0]!.verified).toBe(true);
  });
});

// ── Full metadata identity — all fields must match ───────────

describe('FIX-494: full metadata identity binding per source', () => {
  it('source.projectId mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ projectId: 'proj-002' }),
    ]));
    const manifest = makeManifest({ projectId: 'proj-001' });
    const results = svc.verifyManifest(manifest);
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.projectMatch).toBe(false);
  });

  it('source.title mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ title: 'Completely Different Title' }),
    ]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.titleMatch).toBe(false);
  });

  it('source.authors mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ authors: ['Different Author'] }),
    ]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.authorsMatch).toBe(false);
  });

  it('source.url mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ url: 'https://evil.com/fake' }),
    ]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.urlMatch).toBe(false);
  });

  it('source.kind mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ kind: 'legislative_record' }),
    ]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.kindMatch).toBe(false);
  });

  it('source.correctionState mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ correctionState: 'corrected' }),
    ]));
    const manifest = makeManifest({ sources: [makeSource({ correctionState: 'clean' })] });
    const results = svc.verifyManifest(manifest);
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.correctionMatches).toBe(false);
  });

  it('source.contentDigest mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ contentDigest: 'b'.repeat(64) }),
    ]));
    const manifest = makeManifest({ sources: [makeSource({ contentDigest: 'a'.repeat(64) })] });
    const results = svc.verifyManifest(manifest);
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.contentDigestMatch).toBe(false);
  });

  it('all fields match → source verified', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource()]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.verified).toBe(true);
    expect(results[0]!.reason).toBeUndefined();
  });
});

// ── Time identity — publishedAt/fetchedAt ────────────────────

describe('FIX-494: time identity — publishedAt/fetchedAt', () => {
  it('publishedAt mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ publishedAt: 1700000000000 }),
    ]));
    const manifest = makeManifest({ sources: [makeSource({ publishedAt: 1699999999999 })] });
    const results = svc.verifyManifest(manifest);
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.publishedAtMatch).toBe(false);
  });

  it('fetchedAt mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ fetchedAt: 1700000000000 }),
    ]));
    const manifest = makeManifest({ sources: [makeSource({ fetchedAt: 1699999999999 })] });
    const results = svc.verifyManifest(manifest);
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.fetchedAtMatch).toBe(false);
  });

  it('null vs non-null publishedAt mismatch fails identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ publishedAt: null }),
    ]));
    const manifest = makeManifest({ sources: [makeSource({ publishedAt: 1700000000000 })] });
    const results = svc.verifyManifest(manifest);
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.publishedAtMatch).toBe(false);
  });

  it('matching publishedAt + fetchedAt pass identity', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource()]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.verified).toBe(true);
    expect(results[0]!.publishedAtMatch).toBe(true);
    expect(results[0]!.fetchedAtMatch).toBe(true);
  });
});

// ── Edge cases ────────────────────────────────────────────────

describe('FIX-494: edge cases', () => {
  it('source not found in repository → exists=false', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.exists).toBe(false);
    expect(results[0]!.verified).toBe(false);
    expect(results[0]!.reason).toBe('Source not found in repository');
  });

  it('deleted source in repository fails with deleted=true', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ deleted: true }),
    ]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.deleted).toBe(true);
    expect(results[0]!.verified).toBe(false);
  });

  it('isManifestStale returns true when source mismatches', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ title: 'Different' }),
    ]));
    expect(svc.isManifestStale(makeManifest())).toBe(true);
  });

  it('isManifestStale returns false when everything matches', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource()]));
    expect(svc.isManifestStale(makeManifest())).toBe(false);
  });
});

// ── Snapshot digest — canonical identity binding ─────────────

describe('FIX-494: snapshot digest binds canonical identity', () => {
  it('snapshot digest changes when title differs', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource({ title: 'Title A' })]));
    const m1 = makeManifest({ sources: [makeSource({ title: 'Title A' })] });
    const m2 = makeManifest({ sources: [makeSource({ title: 'Title B' })] });
    expect(svc.computeSourceSnapshotDigest(m1)).not.toBe(svc.computeSourceSnapshotDigest(m2));
  });

  it('snapshot digest changes when url differs', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource({ url: 'https://a.com' })]));
    const m1 = makeManifest({ sources: [makeSource({ url: 'https://a.com' })] });
    const m2 = makeManifest({ sources: [makeSource({ url: 'https://b.com' })] });
    expect(svc.computeSourceSnapshotDigest(m1)).not.toBe(svc.computeSourceSnapshotDigest(m2));
  });

  it('snapshot digest changes when publishedAt differs', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource({ publishedAt: 100 })]));
    const m1 = makeManifest({ sources: [makeSource({ publishedAt: 100 })] });
    const m2 = makeManifest({ sources: [makeSource({ publishedAt: 200 })] });
    expect(svc.computeSourceSnapshotDigest(m1)).not.toBe(svc.computeSourceSnapshotDigest(m2));
  });

  it('snapshot digest changes when kind differs', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource({ kind: 'policy_document' })]));
    const m1 = makeManifest({ sources: [makeSource({ kind: 'policy_document' })] });
    const m2 = makeManifest({ sources: [makeSource({ kind: 'legislative_record' })] });
    expect(svc.computeSourceSnapshotDigest(m1)).not.toBe(svc.computeSourceSnapshotDigest(m2));
  });

  it('snapshot digest stable sort: same sources different order → same digest', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ id: 'src-A', title: 'Title A' }),
      makeRepoSource({ id: 'src-B', title: 'Title B' }),
    ]));
    const mAB = makeManifest({ sources: [
      makeSource({ sourceId: 'src-A', title: 'Title A' }),
      makeSource({ sourceId: 'src-B', title: 'Title B' }),
    ]});
    const mBA = makeManifest({ sources: [
      makeSource({ sourceId: 'src-B', title: 'Title B' }),
      makeSource({ sourceId: 'src-A', title: 'Title A' }),
    ]});
    expect(svc.computeSourceSnapshotDigest(mAB)).toBe(svc.computeSourceSnapshotDigest(mBA));
  });

  it('two different forged sources with same verified=false produce different digests', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ id: 'src-A', title: 'Correct A' }),
      makeRepoSource({ id: 'src-B', title: 'Correct B' }),
    ]));
    const mForgeA = makeManifest({ sources: [makeSource({ sourceId: 'src-A', title: 'Wrong A' })] });
    const mForgeB = makeManifest({ sources: [makeSource({ sourceId: 'src-B', title: 'Wrong B' })] });
    const rA = svc.verifyManifest(mForgeA);
    const rB = svc.verifyManifest(mForgeB);
    expect(rA[0]!.verified).toBe(false);
    expect(rB[0]!.verified).toBe(false);
    expect(svc.computeSourceSnapshotDigest(mForgeA))
      .not.toBe(svc.computeSourceSnapshotDigest(mForgeB));
  });

  it('snapshot digest includes manifest profileId (manifest-level binding)', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource()]));
    const m1 = makeManifest({ profileId: 'profile-alice' });
    const m2 = makeManifest({ profileId: 'profile-bob' });
    // Different manifest profileId → different digest even with same sources
    expect(svc.computeSourceSnapshotDigest(m1)).not.toBe(svc.computeSourceSnapshotDigest(m2));
  });

  it('snapshot digest includes manifest projectId', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource()]));
    const m1 = makeManifest({ projectId: 'proj-A' });
    const m2 = makeManifest({ projectId: 'proj-B' });
    expect(svc.computeSourceSnapshotDigest(m1)).not.toBe(svc.computeSourceSnapshotDigest(m2));
  });

  it('digest is valid SHA-256 hex', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource()]));
    const digest = svc.computeSourceSnapshotDigest(makeManifest());
    expect(digest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('two different stored records both mismatching produce different digests', () => {
    // Source A: stored title 'Real A', manifest says 'Fake X' → mismatch
    // Source B: stored title 'Real B', manifest says 'Fake X' → mismatch
    // Both have verified=false but different canonicalIdentityDigest
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ id: 'src-A', title: 'Real Title A', url: 'https://a.com' }),
      makeRepoSource({ id: 'src-B', title: 'Real Title B', url: 'https://b.com' }),
    ]));
    const m1 = makeManifest({ sources: [makeSource({ sourceId: 'src-A', title: 'Fake Title' })] });
    const m2 = makeManifest({ sources: [makeSource({ sourceId: 'src-B', title: 'Fake Title' })] });
    expect(svc.verifyManifest(m1)[0]!.verified).toBe(false);
    expect(svc.verifyManifest(m2)[0]!.verified).toBe(false);
    // Canonical digests differ because stored records differ
    expect(svc.verifyManifest(m1)[0]!.canonicalIdentityDigest)
      .not.toBe(svc.verifyManifest(m2)[0]!.canonicalIdentityDigest);
    // Snapshot digests differ because canonicalIdentityDigest is in payload
    expect(svc.computeSourceSnapshotDigest(m1))
      .not.toBe(svc.computeSourceSnapshotDigest(m2));
  });
});

// ── canonicalIdentityDigest unit ─────────────────────────────

describe('FIX-494: canonicalIdentityDigest', () => {
  it('found source has non-missing canonicalIdentityDigest', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource()]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.canonicalIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('missing source uses "missing" marker', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.canonicalIdentityDigest).toBe('missing');
  });

  it('deleted source still has real canonicalIdentityDigest', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ deleted: true }),
    ]));
    const results = svc.verifyManifest(makeManifest());
    expect(results[0]!.canonicalIdentityDigest).toMatch(/^[a-f0-9]{64}$/);
  });

  it('same stored record → same canonicalIdentityDigest regardless of manifest', () => {
    const svc = new CurrentAffairsRepositoryService(repoWith([makeRepoSource()]));
    const m1 = makeManifest({ sources: [makeSource({ title: 'Manifest Title A' })] });
    const m2 = makeManifest({ sources: [makeSource({ title: 'Manifest Title B' })] });
    // Both manifests reference same source, so canonicalIdentityDigest is identical
    expect(svc.verifyManifest(m1)[0]!.canonicalIdentityDigest)
      .toBe(svc.verifyManifest(m2)[0]!.canonicalIdentityDigest);
  });

  it('authors sorted in canonical digest (order-independent)', () => {
    const svcA = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ authors: ['Alice', 'Bob'] }),
    ]));
    const svcB = new CurrentAffairsRepositoryService(repoWith([
      makeRepoSource({ authors: ['Bob', 'Alice'] }),
    ]));
    // Same authors, different order → same canonical digest
    expect(svcA.verifyManifest(makeManifest({ sources: [makeSource({ authors: ['Alice', 'Bob'] })] }))[0]!.canonicalIdentityDigest)
      .toBe(svcB.verifyManifest(makeManifest({ sources: [makeSource({ authors: ['Bob', 'Alice'] })] }))[0]!.canonicalIdentityDigest);
  });
});
