/**
 * @vitest-environment node
 * Pure helpers of the research browser service.
 */

import { describe, it, expect } from 'vitest';
import { normalizeHttpUrl, detectDoi } from '../../electron/BrowserService.js';

describe('normalizeHttpUrl', () => {
  it('accepts absolute http(s) URLs unchanged', () => {
    expect(normalizeHttpUrl('https://scholar.google.com/')).toBe('https://scholar.google.com/');
    expect(normalizeHttpUrl('http://example.com')).toBe('http://example.com');
  });

  it('adds https:// to bare domains', () => {
    expect(normalizeHttpUrl('scholar.google.com')).toBe('https://scholar.google.com');
    expect(normalizeHttpUrl('arxiv.org/abs/2401.1')).toBe('https://arxiv.org/abs/2401.1');
  });

  it('rejects empty, whitespace and non-URL input', () => {
    expect(normalizeHttpUrl('')).toBeNull();
    expect(normalizeHttpUrl('   ')).toBeNull();
    expect(normalizeHttpUrl('not a url')).toBeNull();
    expect(normalizeHttpUrl('file:///etc/passwd')).toBeNull();
  });
});

describe('detectDoi', () => {
  it('finds a DOI in running text', () => {
    expect(detectDoi('see 10.1103/PhysRevB.109.174203 for details')).toBe('10.1103/PhysRevB.109.174203');
    expect(detectDoi('doi: 10.1038/s41586-021-03614-1 cited')).toBe('10.1038/s41586-021-03614-1');
  });

  it('strips trailing punctuation', () => {
    expect(detectDoi('(10.1000/xyz123).')).toBe('10.1000/xyz123');
    expect(detectDoi('10.1000/xyz123;')).toBe('10.1000/xyz123');
  });

  it('returns undefined when no DOI is present', () => {
    expect(detectDoi('no doi here')).toBeUndefined();
  });
});
