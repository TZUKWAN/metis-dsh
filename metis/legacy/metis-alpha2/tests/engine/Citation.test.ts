/**
 * Tests for Citation (O8): DOI-based citation extraction for answer provenance.
 */

import { describe, it, expect } from 'vitest';
import {
  extractDoiCitations,
  hasCitations,
  extractCitations,
  CITATIONS_METADATA_KEY,
} from '../../engine/core/Citation.js';

describe('extractDoiCitations', () => {
  it('extracts unique DOIs as citations', () => {
    const citations = extractDoiCitations('See 10.1000/xyz and 10.1001/abc for details.');
    expect(citations).toHaveLength(2);
    expect(citations[0].doi).toBe('10.1000/xyz');
    expect(citations[1].doi).toBe('10.1001/abc');
  });

  it('de-duplicates the same DOI appearing twice', () => {
    const citations = extractDoiCitations('10.1000/xyz is cited; again see 10.1000/xyz.');
    expect(citations).toHaveLength(1);
  });

  it('strips trailing punctuation from the DOI', () => {
    const citations = extractDoiCitations('see 10.1000/xyz.');
    expect(citations[0].doi).toBe('10.1000/xyz');
  });

  it('returns [] for text without DOIs', () => {
    expect(extractDoiCitations('no references here')).toEqual([]);
    expect(extractDoiCitations('')).toEqual([]);
  });

  it('assigns sequential marker ids', () => {
    const citations = extractDoiCitations('10.1000/a, 10.1000/b, 10.1000/c');
    expect(citations.map((c) => c.id)).toEqual(['1', '2', '3']);
  });
});

describe('hasCitations / extractCitations', () => {
  it('detects citations on a metadata blob', () => {
    const meta = { [CITATIONS_METADATA_KEY]: [{ id: '1', label: 'x' }] };
    expect(hasCitations(meta)).toBe(true);
    expect(extractCitations(meta)).toHaveLength(1);
  });

  it('returns false/[] for absent or empty citations', () => {
    expect(hasCitations({})).toBe(false);
    expect(hasCitations(null)).toBe(false);
    expect(extractCitations({})).toEqual([]);
  });
});
