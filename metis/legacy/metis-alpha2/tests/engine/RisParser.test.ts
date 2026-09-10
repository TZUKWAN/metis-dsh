/**
 * RIS parser: Web of Science / Scopus / Zotero RIS exports → paper entries.
 */

import { describe, expect, it } from 'vitest';
import { isRisFormat, parseRis } from '../../engine/research/RisParser';

describe('RisParser', () => {
  it('detects RIS format', () => {
    expect(isRisFormat('TY  - JOUR\nTI  - Title\nER  -')).toBe(true);
    expect(isRisFormat('@article{key, title={x}}')).toBe(false);
    expect(isRisFormat('plain text')).toBe(false);
  });

  it('parses a complete journal entry', () => {
    const ris = `TY  - JOUR
TI  - Attention Is All You Need
AU  - Vaswani, Ashish
AU  - Shazeer, Noam
PY  - 2017
JO  - NeurIPS
AB  - We propose the Transformer architecture.
DO  - 10.5555/3295222.3295349
UR  - https://arxiv.org/abs/1706.03762
ER  -`;
    const entries = parseRis(ris);
    expect(entries).toHaveLength(1);
    expect(entries[0]).toMatchObject({
      title: 'Attention Is All You Need',
      authors: ['Vaswani, Ashish', 'Shazeer, Noam'],
      year: 2017,
      venue: 'NeurIPS',
      abstract: 'We propose the Transformer architecture.',
      doi: '10.5555/3295222.3295349',
      url: 'https://arxiv.org/abs/1706.03762',
    });
  });

  it('parses multiple entries separated by ER', () => {
    const ris = `TY  - JOUR
TI  - First Paper
AU  - Alice
PY  - 2020
ER  -
TY  - CONF
TI  - Second Paper
AU  - Bob
PY  - 2021
T2  - ACL
ER  -`;
    const entries = parseRis(ris);
    expect(entries).toHaveLength(2);
    expect(entries[0]?.title).toBe('First Paper');
    expect(entries[1]?.title).toBe('Second Paper');
    expect(entries[1]?.venue).toBe('ACL');
  });

  it('joins continuation lines into the previous value', () => {
    const ris = `TY  - JOUR
TI  - A Very Long Title
      That Continues Here
PY  - 2019
ER  -`;
    const entries = parseRis(ris);
    expect(entries[0]?.title).toBe('A Very Long Title That Continues Here');
  });

  it('tolerates missing fields and skips empty entries', () => {
    const ris = `TY  - JOUR
PY  - 2022
ER  -
TY  - JOUR
TI  - Only Title
ER  -`;
    const entries = parseRis(ris);
    expect(entries).toHaveLength(1);
    expect(entries[0]?.title).toBe('Only Title');
    expect(entries[0]?.authors).toEqual([]);
    expect(entries[0]?.year).toBe(0);
  });
});
