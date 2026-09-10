/**
 * FIX-METIS-498 — CAS review + SourceAdapter 测试
 *
 * CAS tests: require real SQLite via better-sqlite3. beforeAll throws on
 * ABI mismatch — no silent skip. Lead runs these under Electron Node
 * (ELECTRON_RUN_AS_NODE=1) for matching NODE_MODULE_VERSION 146.
 *
 * SourceAdapter tests: pure logic, no SQLite dependency.
 */
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import BetterSqlite3 from 'better-sqlite3';
import type Database from 'better-sqlite3';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ResearchRepository } from '../../engine/persistence/ResearchRepository.js';
import type { Source } from '../../engine/persistence/researchModel.js';
import { SCHEMA_SQL } from '../../engine/persistence/schema.js';
import { adaptSource } from '../../engine/writing/CurrentAffairsSourceAdapter.js';

// ── Real 64-hex test hashes ───────────────────────────────────

const H = {
  a: 'aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
  b: 'bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
  c: 'cccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccccc',
  d: 'dddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddddd',
  e: 'eeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee',
  f: 'ffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffffff',
  g: '1111111111111111111111111111111111111111111111111111111111111111',
  h: '2222222222222222222222222222222222222222222222222222222222222222',
  i: '3333333333333333333333333333333333333333333333333333333333333333',
  j: '4444444444444444444444444444444444444444444444444444444444444444',
  k: '5555555555555555555555555555555555555555555555555555555555555555',
  l: '6666666666666666666666666666666666666666666666666666666666666666',
  m: '7777777777777777777777777777777777777777777777777777777777777777',
  n: '8888888888888888888888888888888888888888888888888888888888888888',
  o: '9999999999999999999999999999999999999999999999999999999999999999',
  p: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  q: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  r1: 'deadbeef00000000deadbeef00000000deadbeef00000000deadbeef00000000',
  r2: 'cafebabe11111111cafebabe11111111cafebabe11111111cafebabe11111111',
  r3: '0badc0de222222220badc0de222222220badc0de222222220badc0de22222222',
  r4: 'decaf55533333333decaf55533333333decaf55533333333decaf55533333333',
  r5: '5afebabe444444445afebabe444444445afebabe444444445afebabe44444444',
  r6: '6ecaf000555555556ecaf000555555556ecaf000555555556ecaf00055555555',
  r7: '7addbed0666666667addbed0666666667addbed0666666667addbed066666666',
  r8: '8e1faced777777778e1faced777777778e1faced777777778e1faced77777777',
  r9: '9aceb00b888888889aceb00b888888889aceb00b888888889aceb00b88888888',
  h1: 'faceb00c00000000faceb00c00000000faceb00c00000000faceb00c00000000',
  h2a: createHash('sha256').update('h2a-old-hash').digest('hex'),
  h2b: createHash('sha256').update('h2b-new-hash').digest('hex'),
  h3: '0123456789abcdef0123456789abcdef0123456789abcdef0123456789abcdef',
  h4: 'abcdef0123456789abcdef0123456789abcdef0123456789abcdef0123456789',
  h5: 'fedcba9876543210fedcba9876543210fedcba9876543210fedcba9876543210',
  hd1: createHash('sha256').update('hd1').digest('hex'),
  hd2: createHash('sha256').update('hd2').digest('hex'),
};

// ═══════════════════════════════════════════════════════════════
// CAS review — requires real SQLite
// ═══════════════════════════════════════════════════════════════

describe('FIX-METIS-498 CAS review (重开)', () => {
  let dbPath: string;
  let db: Database;
  let repo: ResearchRepository;

  beforeAll(() => {
    dbPath = path.join(os.tmpdir(), `metis-cas-review-${Math.random().toString(36).slice(2, 8)}.db`);
    db = new BetterSqlite3(dbPath);
    db.pragma('journal_mode = WAL');
    db.pragma('foreign_keys = ON');
    db.exec(SCHEMA_SQL);
    const now = Date.now();
    db.prepare(`INSERT INTO projects (id, title, original_intent, research_question, lifecycle, methodology, discipline, metadata, created_at, updated_at, version, source)
      VALUES ('proj-1','Test','','','active','','','{}',?,?,1,'test')`).run(now, now);
    repo = new ResearchRepository(db);
  });

  afterAll(() => {
    try { repo.close(); } catch { /* best-effort */ }
    try { fs.unlinkSync(dbPath); } catch { /* best-effort */ }
    try { fs.unlinkSync(dbPath + '-wal'); } catch { /* best-effort */ }
    try { fs.unlinkSync(dbPath + '-shm'); } catch { /* best-effort */ }
  });

  function makeSource(overrides: Partial<Source> = {}): Source {
    const now = Date.now();
    return {
      id: `src-${Math.random().toString(36).slice(2, 10)}`,
      projectId: 'proj-1', kind: 'paper', title: 'Test Source',
      authors: ['Author One'], year: 2025, venue: 'Test Venue',
      identifier: '10.1234/test', identifierType: 'doi',
      filePath: null, externalUrl: null,
      tags: [], metadata: {},
      sourceVersionHash: H.a, provenance: {},
      createdAt: now - 10000, updatedAt: now, deletedAt: null,
      ...overrides,
    };
  }

  function seedSource(overrides: Partial<Source> = {}): Source {
    const s = makeSource(overrides);
    repo.insertSourceIfAbsent(s);
    return s;
  }

  const REVIEWED_BY = 'auditor-1';
  const NOTE = 'Reviewed and classified.';

  // ── Happy paths ────────────────────────────────────────────

  it('untagged source → successfully classified with selected caKind', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.b });
    const result = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.tags).toEqual(['current-affairs:policy_document']);
    expect(result.source.metadata.caCorrectionState).toBe('clean');
    expect(result.source.metadata.caReviewedBy).toBe(REVIEWED_BY);
    expect(result.source.metadata.caNote).toBe(NOTE);
    expect(typeof result.source.metadata.caReviewedAt).toBe('number');
    expect(typeof result.source.metadata.caReviewDigest).toBe('string');
    expect((result.source.metadata.caReviewDigest as string).length).toBe(64);
    expect(result.source.updatedAt).toBeGreaterThan(src.updatedAt);
    expect(result.source.deletedAt).toBeNull();
  });

  it('ambiguous tags → atomic replacement', () => {
    const src = seedSource({
      tags: ['current-affairs:policy_document', 'current-affairs:legislative_record', 'other-tag'],
      sourceVersionHash: H.c,
    });
    const result = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'official_statistics', correctionState: 'corrected', reviewedBy: REVIEWED_BY, note: 'Reclassified.' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.tags).toContain('other-tag');
    expect(result.source.tags).toContain('current-affairs:official_statistics');
    expect(result.source.tags).not.toContain('current-affairs:policy_document');
    expect(result.source.tags).not.toContain('current-affairs:legislative_record');
    expect(result.source.tags.filter((t: string) => t.startsWith('current-affairs:')).length).toBe(1);
  });

  it('single existing CA tag replaced with new caKind', () => {
    const src = seedSource({ tags: ['current-affairs:expert_testimony'], sourceVersionHash: H.d });
    const result = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'institutional_report', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.source.tags).toContain('current-affairs:institutional_report');
    expect(result.source.tags).not.toContain('current-affairs:expert_testimony');
  });

  // ── Deleted source must fail ────────────────────────────────

  it('deleted source → fails regardless of caller parameters', () => {
    const src = seedSource({ tags: ['current-affairs:policy_document'], deletedAt: Date.now() - 1000 });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'retracted', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('source_deleted');
  });

  // ── CAS mismatches ──────────────────────────────────────────

  it('projectId mismatch → fails', () => {
    const src = seedSource({ tags: ['current-affairs:regulatory_filing'] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: 'wrong-proj', sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'regulatory_filing', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('project_mismatch');
  });

  it('sourceVersionHash mismatch → fails', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.e });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: H.f, updatedAt: src.updatedAt,
    }, { caKind: 'authoritative_news', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('hash_mismatch');
  });

  it('null vs non-null hash mismatch → fails', () => {
    const s1 = seedSource({ tags: [], sourceVersionHash: null });
    const r1 = repo.reviewCurrentAffairsSource(s1.id, {
      projectId: s1.projectId, sourceVersionHash: H.g, updatedAt: s1.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r1.ok).toBe(false);
    if (!r1.ok) expect(r1.code).toBe('hash_mismatch');

    const s2 = seedSource({ tags: [], sourceVersionHash: H.h });
    const r2 = repo.reviewCurrentAffairsSource(s2.id, {
      projectId: s2.projectId, sourceVersionHash: null, updatedAt: s2.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r2.ok).toBe(false);
    if (!r2.ok) expect(r2.code).toBe('hash_mismatch');
  });

  it('updatedAt mismatch (stale) → fails with code stale', () => {
    const src = seedSource({ tags: [] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt - 1,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('stale');
  });

  it('source not found → fails', () => {
    const r = repo.reviewCurrentAffairsSource('nonexistent', {
      projectId: 'proj-1', sourceVersionHash: H.i, updatedAt: Date.now(),
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('not_found');
  });

  // ── Input validation ────────────────────────────────────────

  it('invalid expected.sourceVersionHash (non-hex) → rejected', () => {
    const src = seedSource({ tags: [] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: 'not-a-hex-hash!!!-zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_expected_hash');
  });

  it('invalid expected.sourceVersionHash (wrong length) → rejected', () => {
    const src = seedSource({ tags: [] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: 'abc123', updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_expected_hash');
  });

  it('empty reviewedBy → fails', () => {
    const src = seedSource({ tags: [] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: '', note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_reviewed_by');
  });

  it('reviewedBy with control characters → fails', () => {
    const src = seedSource({ tags: [] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: 'bad\x00char', note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_reviewed_by');
  });

  it('excessively long reviewedBy → fails', () => {
    const src = seedSource({ tags: [] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: 'x'.repeat(257), note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_reviewed_by');
  });

  it('excessively long note → fails', () => {
    const src = seedSource({ tags: [] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: 'x'.repeat(2001) });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_note');
  });

  it('arbitrary correction string rejected at runtime', () => {
    const src = seedSource({ tags: [] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'bogus' as unknown as typeof ResearchRepository.CA_CORRECTION_STATES[number], reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_correction_state');
  });

  it('arbitrary caKind string rejected at runtime', () => {
    const src = seedSource({ tags: [] });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'fake_news' as unknown as typeof ResearchRepository.CA_KINDS[number], correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_ca_kind');
  });

  // ── Atomicity ───────────────────────────────────────────────

  it('failed CAS does not partially write metadata', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.j });
    const origMeta = { ...src.metadata };
    const origTags = [...src.tags];
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: H.k, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'corrected', reviewedBy: REVIEWED_BY, note: 'no' });
    expect(r.ok).toBe(false);
    const fresh = repo.getSource(src.id);
    expect(fresh).toBeDefined();
    expect(fresh!.metadata).toEqual(origMeta);
    expect(fresh!.tags).toEqual(origTags);
    expect(fresh!.updatedAt).toBe(src.updatedAt);
  });

  // ── Reread verification ─────────────────────────────────────

  it('reread: all audit fields + unique tag + project + hash + deleted verified', () => {
    const src = seedSource({ tags: ['current-affairs:authoritative_news', 'extra-tag'], sourceVersionHash: H.l });
    const before = Date.now();
    const result = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'regulatory_filing', correctionState: 'correction_pending', reviewedBy: 'reviewer-99', note: 'Needs follow-up.' });
    expect(result.ok).toBe(true);
    if (!result.ok) return;

    const fresh = repo.getSource(src.id);
    expect(fresh).toBeDefined();
    if (!fresh) return;

    const caTags = fresh.tags.filter((t: string) => t.startsWith('current-affairs:'));
    expect(caTags).toEqual(['current-affairs:regulatory_filing']);
    expect(fresh.tags).toContain('extra-tag');
    expect(fresh.tags).not.toContain('current-affairs:authoritative_news');
    expect(fresh.metadata.caCorrectionState).toBe('correction_pending');
    expect(fresh.metadata.caReviewedBy).toBe('reviewer-99');
    expect(fresh.metadata.caNote).toBe('Needs follow-up.');
    expect(typeof fresh.metadata.caReviewedAt).toBe('number');
    expect(fresh.metadata.caReviewedAt).toBeGreaterThanOrEqual(before);
    expect(typeof fresh.metadata.caReviewDigest).toBe('string');
    expect((fresh.metadata.caReviewDigest as string).length).toBe(64);

    const expectedDigest = createHash('sha256')
      .update(JSON.stringify([
        src.id, src.projectId, src.sourceVersionHash, src.updatedAt,
        'regulatory_filing', 'correction_pending', 'reviewer-99', 'Needs follow-up.', fresh.metadata.caReviewedAt,
      ]))
      .digest('hex');
    expect(fresh.metadata.caReviewDigest).toBe(expectedDigest);
    expect(fresh.metadata.caReviewedSourceVersionHash).toBe(src.sourceVersionHash);
    expect(fresh.projectId).toBe(src.projectId);
    expect(fresh.sourceVersionHash).toBe(src.sourceVersionHash);
    expect(fresh.deletedAt).toBeNull();
    expect(fresh.updatedAt).toBeGreaterThan(src.updatedAt);
  });

  // ── Malicious tags ──────────────────────────────────────────

  it('malicious tag: not-current-affairs:* and xcurrent-affairs:* preserved, true CA tag replaced', () => {
    const src = seedSource({
      tags: ['current-affairs:policy_document', 'not-current-affairs:fake', 'xcurrent-affairs:evil'],
    });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'official_statistics', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.source.tags).toContain('not-current-affairs:fake');
    expect(r.source.tags).toContain('xcurrent-affairs:evil');
    expect(r.source.tags).not.toContain('current-affairs:policy_document');
    expect(r.source.tags).toContain('current-affairs:official_statistics');
  });

  // ── reviewDigest uniqueness ─────────────────────────────────

  it('different review inputs produce different reviewDigest', () => {
    const s1 = seedSource({ tags: [], sourceVersionHash: H.m });
    const s2 = seedSource({ tags: [], sourceVersionHash: H.n });
    const r1 = repo.reviewCurrentAffairsSource(s1.id, {
      projectId: s1.projectId, sourceVersionHash: s1.sourceVersionHash, updatedAt: s1.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: 'a', note: 'Note A' });
    const r2 = repo.reviewCurrentAffairsSource(s2.id, {
      projectId: s2.projectId, sourceVersionHash: s2.sourceVersionHash, updatedAt: s2.updatedAt,
    }, { caKind: 'legislative_record', correctionState: 'corrected', reviewedBy: 'b', note: 'Note B' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.source.metadata.caReviewDigest).not.toBe(r2.source.metadata.caReviewDigest);
    }
  });

  // ── State transition rules ──────────────────────────────────

  it('retracted → retracted allowed', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.r1, metadata: { caCorrectionState: 'retracted', caReviewedSourceVersionHash: H.r1, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev', caNote: 'old' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'retracted', reviewedBy: REVIEWED_BY, note: 'Still retracted.' });
    expect(r.ok).toBe(true);
  });

  it('retracted → clean rejected (same hash)', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.r2, metadata: { caCorrectionState: 'retracted', caReviewedSourceVersionHash: H.r2, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_transition');
  });

  it('retracted → corrected rejected', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.r3, metadata: { caCorrectionState: 'retracted', caReviewedSourceVersionHash: H.r3, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'corrected', reviewedBy: REVIEWED_BY, note: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_transition');
  });

  it('retracted → correction_pending rejected', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.r4, metadata: { caCorrectionState: 'retracted', caReviewedSourceVersionHash: H.r4, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'correction_pending', reviewedBy: REVIEWED_BY, note: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_transition');
  });

  it('correction_pending → corrected allowed', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.r5, metadata: { caCorrectionState: 'correction_pending', caReviewedSourceVersionHash: H.r5, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'corrected', reviewedBy: REVIEWED_BY, note: 'Resolved.' });
    expect(r.ok).toBe(true);
  });

  it('correction_pending → retracted allowed', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.r6, metadata: { caCorrectionState: 'correction_pending', caReviewedSourceVersionHash: H.r6, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'retracted', reviewedBy: REVIEWED_BY, note: 'Now retracted.' });
    expect(r.ok).toBe(true);
  });

  it('correction_pending → clean rejected', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.r7, metadata: { caCorrectionState: 'correction_pending', caReviewedSourceVersionHash: H.r7, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_transition');
  });

  it('correction_pending → correction_pending rejected (must progress)', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.r8, metadata: { caCorrectionState: 'correction_pending', caReviewedSourceVersionHash: H.r8, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'correction_pending', reviewedBy: REVIEWED_BY, note: 'x' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_transition');
  });

  it('clean → retracted allowed', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.r9, metadata: { caCorrectionState: 'clean', caReviewedSourceVersionHash: H.r9, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'retracted', reviewedBy: REVIEWED_BY, note: 'Retracting.' });
    expect(r.ok).toBe(true);
  });

  it('corrected → retracted allowed', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.p, metadata: { caCorrectionState: 'corrected', caReviewedSourceVersionHash: H.p, caReviewedAt: Date.now() - 10000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'retracted', reviewedBy: REVIEWED_BY, note: 'Retracting.' });
    expect(r.ok).toBe(true);
  });

  it('unreviewed (no prior caCorrectionState) → any state allowed', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.o, metadata: {} });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'retracted', reviewedBy: REVIEWED_BY, note: 'First review.' });
    expect(r.ok).toBe(true);
  });

  // ── Hash-aware transitions ──────────────────────────────────

  it('same hash retracted→clean fails (laundering blocked)', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.h1, metadata: { caCorrectionState: 'retracted', caReviewedSourceVersionHash: H.h1, caReviewedAt: Date.now() - 5000, caReviewedBy: 'prev' } });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: 'Try laundering.' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_transition');
  });

  it('legacy retracted (no stored hash) → clean fails (fail-closed)', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.q, metadata: { caCorrectionState: 'retracted', caReviewedAt: Date.now() - 5000, caReviewedBy: 'old-reviewer' } });
    // No caReviewedSourceVersionHash → legacy → enforce restrictions (fail-closed)
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: src.sourceVersionHash, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: 'Try laundering legacy.' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_transition');
  });

  it('hash changed: retracted with new hash → reclassification to clean allowed', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.h2a, metadata: { caCorrectionState: 'retracted', caReviewedSourceVersionHash: H.h2a, caReviewedAt: Date.now() - 5000, caReviewedBy: 'prev' } });
    const newUpdatedAt = Math.max(Date.now(), src.updatedAt + 1);
    const updated = { ...src, sourceVersionHash: H.h2b, updatedAt: newUpdatedAt };
    repo.saveSource(updated);
    const reloaded = repo.getSource(src.id);
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: H.h2b, updatedAt: reloaded!.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: 'New version, reclassified.' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source.metadata.caCorrectionState).toBe('clean');
      expect(r.source.metadata.caReviewedSourceVersionHash).toBe(H.h2b);
    }
  });

  it('fake expected old hash → fails hash_mismatch', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.h4 });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: H.h5, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: 'Fake hash.' });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('hash_mismatch');
  });

  it('reviewDigest changes with hash', () => {
    const s1 = seedSource({ tags: [], sourceVersionHash: H.hd1 });
    const s2 = seedSource({ tags: [], sourceVersionHash: H.hd2 });
    const r1 = repo.reviewCurrentAffairsSource(s1.id, {
      projectId: s1.projectId, sourceVersionHash: s1.sourceVersionHash, updatedAt: s1.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: 'x', note: 'v1' });
    const r2 = repo.reviewCurrentAffairsSource(s2.id, {
      projectId: s2.projectId, sourceVersionHash: s2.sourceVersionHash, updatedAt: s2.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: 'x', note: 'v1' });
    expect(r1.ok).toBe(true);
    expect(r2.ok).toBe(true);
    if (r1.ok && r2.ok) {
      expect(r1.source.metadata.caReviewDigest).not.toBe(r2.source.metadata.caReviewDigest);
    }
  });

  it('null hash: stored as empty string, reread correctly', () => {
    const src = seedSource({ tags: [], sourceVersionHash: null });
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: null, updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: 'Null hash review.' });
    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.source.metadata.caReviewedSourceVersionHash).toBe('');
      const fresh = repo.getSource(src.id);
      expect(fresh).toBeDefined();
      expect(fresh!.metadata.caReviewedSourceVersionHash).toBe('');
    }
  });

  it('invalid expected hash → rejected and DB unchanged', () => {
    const src = seedSource({ tags: [], sourceVersionHash: H.a });
    const origMeta = repo.getSource(src.id)!.metadata;
    const r = repo.reviewCurrentAffairsSource(src.id, {
      projectId: src.projectId, sourceVersionHash: 'not-hex!!', updatedAt: src.updatedAt,
    }, { caKind: 'policy_document', correctionState: 'clean', reviewedBy: REVIEWED_BY, note: NOTE });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.code).toBe('invalid_expected_hash');
    // DB unchanged
    const fresh = repo.getSource(src.id);
    expect(fresh!.metadata).toEqual(origMeta);
  });
});

// ═══════════════════════════════════════════════════════════════
// SourceAdapter — pure logic, no SQLite dependency
// ═══════════════════════════════════════════════════════════════

describe('FIX-METIS-498 SourceAdapter — 不默认clean，显式字段', () => {
  function makeSrc(overrides: Partial<Source> = {}): Source {
    const now = Date.now();
    return {
      id: 'adapter-src', projectId: 'proj-1', kind: 'paper',
      title: 'T', authors: ['A'], year: 2025, venue: 'V',
      identifier: '10.1234/t', identifierType: 'doi',
      filePath: null, externalUrl: null,
      tags: ['current-affairs:policy_document'],
      metadata: { caCorrectionState: 'clean' },
      sourceVersionHash: 'zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz',
      provenance: {},
      createdAt: now, updatedAt: now, deletedAt: null,
      ...overrides,
    };
  }

  it('correctionState from metadata.caCorrectionState → mapped correctly', () => {
    const a = adaptSource(makeSrc({ metadata: { caCorrectionState: 'corrected' } }));
    expect(a).not.toBeNull();
    expect(a!.correctionState).toBe('corrected');
  });

  it('correctionState missing → adapter returns null (不默认clean)', () => {
    expect(adaptSource(makeSrc({ metadata: {} }))).toBeNull();
  });

  it('correctionState illegal → adapter returns null', () => {
    expect(adaptSource(makeSrc({ metadata: { caCorrectionState: 'bogus' } }))).toBeNull();
  });

  it('publishedAt from metadata.publishedAt explicitly', () => {
    const pubAt = Date.now() - 86400000;
    const a = adaptSource(makeSrc({ metadata: { caCorrectionState: 'clean', publishedAt: pubAt } }));
    expect(a).not.toBeNull();
    expect(a!.publishedAt).toBe(pubAt);
  });

  it('publishedAt missing → null', () => {
    const a = adaptSource(makeSrc({ metadata: { caCorrectionState: 'clean' } }));
    expect(a).not.toBeNull();
    expect(a!.publishedAt).toBeNull();
  });

  it('fetchedAt from metadata.fetchedAt, fallback to createdAt', () => {
    const fetchAt = Date.now() - 3600000;
    const a1 = adaptSource(makeSrc({ metadata: { caCorrectionState: 'clean', fetchedAt: fetchAt } }));
    expect(a1!.fetchedAt).toBe(fetchAt);
    const a2 = adaptSource(makeSrc({ metadata: { caCorrectionState: 'clean' }, createdAt: 999888777000 }));
    expect(a2!.fetchedAt).toBe(999888777000);
  });

  it('updatedAt from source.updatedAt explicitly', () => {
    const a = adaptSource(makeSrc({ metadata: { caCorrectionState: 'clean' }, updatedAt: 111222333000 }));
    expect(a!.updatedAt).toBe(111222333000);
  });

  it('missing CA tag → adapter returns null', () => {
    expect(adaptSource(makeSrc({ tags: ['other-tag'] }))).toBeNull();
  });

  it('ambiguous CA tags → adapter returns null', () => {
    expect(adaptSource(makeSrc({
      tags: ['current-affairs:policy_document', 'current-affairs:legislative_record'],
    }))).toBeNull();
  });

  it('deleted source → deleted: true', () => {
    const a = adaptSource(makeSrc({ deletedAt: Date.now() }));
    expect(a).not.toBeNull();
    expect(a!.deleted).toBe(true);
  });

  it('contentDigest from sourceVersionHash', () => {
    const a = adaptSource(makeSrc());
    expect(a).not.toBeNull();
    expect(a!.contentDigest).toBe('zzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzzz');
  });
});
