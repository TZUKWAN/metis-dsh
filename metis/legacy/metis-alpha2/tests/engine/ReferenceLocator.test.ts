/**
 * Tests for ReferenceLocator (O9): reference-section detection for Smart Jump.
 */

import { describe, it, expect } from 'vitest';
import { findReferenceSection, findReferencePage } from '../../engine/research/ReferenceLocator.js';

function makePages(entries: Array<[number, string]>): Map<number, string> {
  return new Map(entries);
}

describe('findReferenceSection', () => {
  it('locates a References section in the back third', () => {
    const map = makePages([
      [1, 'Introduction ...'],
      [2, 'Methods ...'],
      [3, 'Results ...'],
      [4, 'References\n[1] Vaswani et al. Attention...'],
      [5, '[2] Some other work\n[3] More'],
    ]);
    const section = findReferenceSection(map);
    expect(section).not.toBeNull();
    expect(section?.startPage).toBe(4);
    expect(section?.endPage).toBe(5);
  });

  it('locates a 参考文献 header', () => {
    const map = makePages([
      [1, '正文'],
      [2, '参考文献\n[1] 文献甲'],
    ]);
    const section = findReferenceSection(map);
    expect(section?.startPage).toBe(2);
  });

  it('returns null when no reference section exists', () => {
    const map = makePages([
      [1, 'Just an abstract'],
      [2, 'Some body text'],
    ]);
    expect(findReferenceSection(map)).toBeNull();
  });

  it('returns null for an empty map', () => {
    expect(findReferenceSection(new Map())).toBeNull();
  });
});

describe('findReferencePage', () => {
  it('finds the page containing [n] inside the section', () => {
    const map = makePages([
      [4, 'References\n[1] Vaswani\n[2] Other'],
      [5, '[3] Third\n[4] Fourth'],
    ]);
    const section = { startPage: 4, endPage: 5 };
    expect(findReferencePage(map, section, 1)).toBe(4);
    expect(findReferencePage(map, section, 3)).toBe(5);
    expect(findReferencePage(map, section, 99)).toBeNull();
  });

  it('matches (n) citation style', () => {
    const map = makePages([[4, 'References\n(7) Some work']]);
    const section = { startPage: 4, endPage: 4 };
    expect(findReferencePage(map, section, 7)).toBe(4);
  });
});
