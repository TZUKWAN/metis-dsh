/**
 * METIS-404 — Evidence anchor tests.
 *
 * Covers: each of the 5 anchor types builds + validates; invalid anchors rejected; snippet
 * hash captures content; staleness detection on source update; relocation target for
 * "click → jump to original position".
 */

import { describe, it, expect } from 'vitest';
import {
  validateAnchor,
  buildEvidence,
  snippetHash,
  checkFreshness,
  relocationFor,
  type AnchorSpec,
} from './EvidenceAnchor.js';

describe('METIS-404 EvidenceAnchor — five anchor types validate and build', () => {
  const cases: Array<{ name: string; anchor: AnchorSpec }> = [
    { name: 'page', anchor: { type: 'page', pageNumber: 7 } },
    { name: 'char_range', anchor: { type: 'char_range', start: 120, end: 180 } },
    { name: 'timestamp', anchor: { type: 'timestamp', timestamp: 42.5 } },
    { name: 'region', anchor: { type: 'region', start: 10, end: 20 } },
    { name: 'row', anchor: { type: 'row', start: 33 } },
  ];
  for (const c of cases) {
    it(`validates a well-formed ${c.name} anchor`, () => {
      expect(validateAnchor(c.anchor).valid).toBe(true);
    });
    it(`builds an Evidence with anchorType=${c.name}`, () => {
      const ev = buildEvidence({
        id: 'e1', projectId: 'p1', sourceId: 's1',
        anchor: c.anchor, snippet: '原文片段', sourceVersionHash: 'v1',
      });
      expect(ev.anchorType).toBe(c.anchor.type);
      expect(ev.snippetHash).toBe(snippetHash('原文片段'));
      expect(ev.sourceVersionHash).toBe('v1');
    });
  }
});

describe('METIS-404 EvidenceAnchor — invalid anchors rejected', () => {
  it('rejects page anchor without pageNumber', () => {
    expect(validateAnchor({ type: 'page' }).valid).toBe(false);
  });
  it('rejects page anchor with pageNumber < 1', () => {
    expect(validateAnchor({ type: 'page', pageNumber: 0 }).valid).toBe(false);
  });
  it('rejects char_range with end <= start', () => {
    expect(validateAnchor({ type: 'char_range', start: 10, end: 10 }).valid).toBe(false);
    expect(validateAnchor({ type: 'char_range', start: 20, end: 10 }).valid).toBe(false);
  });
  it('rejects char_range missing bounds', () => {
    expect(validateAnchor({ type: 'char_range', start: 10 }).valid).toBe(false);
  });
  it('rejects timestamp < 0', () => {
    expect(validateAnchor({ type: 'timestamp', timestamp: -1 }).valid).toBe(false);
  });
  it('rejects row < 0', () => {
    expect(validateAnchor({ type: 'row', start: -1 }).valid).toBe(false);
  });
  it('buildEvidence throws on invalid anchor', () => {
    expect(() => buildEvidence({
      id: 'e', projectId: 'p', sourceId: 's',
      anchor: { type: 'page', pageNumber: 0 }, snippet: 'x', sourceVersionHash: 'v',
    })).toThrow(/Invalid anchor/);
  });
});

describe('METIS-404 EvidenceAnchor — freshness / staleness on source update', () => {
  const ev = buildEvidence({
    id: 'e1', projectId: 'p1', sourceId: 's1',
    anchor: { type: 'page', pageNumber: 3 }, snippet: '原文', sourceVersionHash: 'hash-v1',
  });

  it('is fresh when source version hash matches', () => {
    expect(checkFreshness(ev, 'hash-v1')).toBe('fresh');
  });
  it('is stale when source was updated (version hash changed)', () => {
    expect(checkFreshness(ev, 'hash-v2')).toBe('stale');
  });
  it('is fresh when evidence has no baseline hash (legacy)', () => {
    const legacy = { ...ev, sourceVersionHash: null };
    expect(checkFreshness(legacy, 'anything')).toBe('fresh');
  });
});

describe('METIS-404 EvidenceAnchor — relocation (click → original position)', () => {
  it('produces a relocation target with the source + anchor coordinates', () => {
    const ev = buildEvidence({
      id: 'e1', projectId: 'p1', sourceId: 's1',
      anchor: { type: 'char_range', start: 100, end: 150 }, snippet: '片段', sourceVersionHash: 'v',
    });
    const target = relocationFor(ev);
    expect(target.sourceId).toBe('s1');
    expect(target.anchorType).toBe('char_range');
    expect(target.start).toBe(100);
    expect(target.end).toBe(150);
    expect(target.snippet).toBe('片段');
  });
  it('relocation carries timestamp for audio evidence', () => {
    const ev = buildEvidence({
      id: 'e2', projectId: 'p1', sourceId: 's1',
      anchor: { type: 'timestamp', timestamp: 30 }, snippet: '语音片段', sourceVersionHash: 'v',
    });
    expect(relocationFor(ev).timestamp).toBe(30);
  });
  it('relocation snippetHash matches the captured hash (integrity check on jump)', () => {
    const ev = buildEvidence({
      id: 'e3', projectId: 'p1', sourceId: 's1',
      anchor: { type: 'row', start: 5 }, snippet: '数据行', sourceVersionHash: 'v',
    });
    expect(relocationFor(ev).snippetHash).toBe(snippetHash('数据行'));
  });
});
