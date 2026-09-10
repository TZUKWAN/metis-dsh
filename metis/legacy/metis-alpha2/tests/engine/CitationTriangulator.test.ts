/**
 * Tests for CitationTriangulator.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import { triangulateDoi, triangulationResultToPlain } from '../../engine/research/CitationTriangulator.js';

vi.mock('../../engine/research/CrossrefClient.js', () => ({
  getWorkByDoi: vi.fn(),
}));

vi.mock('../../engine/research/OpenAlexClient.js', () => ({
  getWorkByDoi: vi.fn(),
}));

vi.mock('../../engine/research/SemanticScholarClient.js', () => ({
  getPaperById: vi.fn(),
}));

import { getWorkByDoi as getCrossrefWorkByDoi } from '../../engine/research/CrossrefClient.js';
import { getWorkByDoi as getOpenAlexWorkByDoi } from '../../engine/research/OpenAlexClient.js';
import { getPaperById } from '../../engine/research/SemanticScholarClient.js';

describe('CitationTriangulator', () => {
  const originalDate = global.Date;

  beforeEach(() => {
    vi.resetAllMocks();
    global.Date = class extends Date {
      getFullYear() {
        return 2026;
      }
    } as unknown as DateConstructor;
  });

  afterEach(() => {
    global.Date = originalDate;
  });

  it('returns VERIFIED when all three indexes agree', async () => {
    vi.mocked(getCrossrefWorkByDoi).mockResolvedValue({
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice Author'],
      year: 2020,
      venue: 'Journal',
    });
    vi.mocked(getOpenAlexWorkByDoi).mockResolvedValue({
      id: 'W1',
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice Author'],
      year: 2020,
      venue: 'Journal',
    });
    vi.mocked(getPaperById).mockResolvedValue({
      paperId: 'DOI:10.1234/example',
      title: 'Example Paper',
      authors: [{ name: 'Alice Author' }],
      year: 2020,
      venue: 'Journal',
    });

    const result = await triangulateDoi('10.1234/example');

    expect(result.overall).toBe('VERIFIED');
    expect(result.existsIn).toHaveLength(3);
    expect(result.warnings).toHaveLength(0);
  });

  it('returns INCONSISTENT when titles differ', async () => {
    vi.mocked(getCrossrefWorkByDoi).mockResolvedValue({
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice Author'],
      year: 2020,
      venue: 'Journal',
    });
    vi.mocked(getOpenAlexWorkByDoi).mockResolvedValue({
      id: 'W1',
      doi: '10.1234/example',
      title: 'Different Title',
      authors: ['Alice Author'],
      year: 2020,
      venue: 'Journal',
    });
    vi.mocked(getPaperById).mockResolvedValue({
      paperId: 'DOI:10.1234/example',
      title: 'Example Paper',
      authors: [{ name: 'Alice Author' }],
      year: 2020,
      venue: 'Journal',
    });

    const result = await triangulateDoi('10.1234/example');

    expect(result.overall).toBe('INCONSISTENT');
    expect(result.titleConsensus).toBe('partial');
    expect(result.warnings.some((w) => w.includes('Title differs'))).toBe(true);
  });

  it('returns PARTIAL when only one index confirms', async () => {
    vi.mocked(getCrossrefWorkByDoi).mockResolvedValue({
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice Author'],
      year: 2020,
      venue: 'Journal',
    });
    vi.mocked(getOpenAlexWorkByDoi).mockResolvedValue(null);
    vi.mocked(getPaperById).mockResolvedValue(null);

    const result = await triangulateDoi('10.1234/example');

    expect(result.overall).toBe('PARTIAL');
    expect(result.existsIn).toEqual(['crossref']);
    expect(result.warnings.some((w) => w.includes('Only one index'))).toBe(true);
  });

  it('returns NOT_FOUND when all indexes miss', async () => {
    vi.mocked(getCrossrefWorkByDoi).mockResolvedValue(null);
    vi.mocked(getOpenAlexWorkByDoi).mockResolvedValue(null);
    vi.mocked(getPaperById).mockResolvedValue(null);

    const result = await triangulateDoi('10.0000/missing');

    expect(result.overall).toBe('NOT_FOUND');
    expect(result.warnings.some((w) => w.includes('not found'))).toBe(true);
  });

  it('normalizes DOI input with prefix and uppercase', async () => {
    vi.mocked(getCrossrefWorkByDoi).mockResolvedValue({
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice Author'],
      year: 2020,
      venue: 'Journal',
    });
    vi.mocked(getOpenAlexWorkByDoi).mockResolvedValue(null);
    vi.mocked(getPaperById).mockResolvedValue(null);

    const result = await triangulateDoi('https://doi.org/10.1234/EXAMPLE');

    expect(result.normalizedDoi).toBe('10.1234/example');
  });

  it('flags future years', async () => {
    vi.mocked(getCrossrefWorkByDoi).mockResolvedValue({
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice Author'],
      year: 2030,
      venue: 'Journal',
    });
    vi.mocked(getOpenAlexWorkByDoi).mockResolvedValue(null);
    vi.mocked(getPaperById).mockResolvedValue(null);

    const result = await triangulateDoi('10.1234/example');

    expect(result.warnings.some((w) => w.includes('future'))).toBe(true);
  });

  it('converts result to plain object', async () => {
    vi.mocked(getCrossrefWorkByDoi).mockResolvedValue({
      doi: '10.1234/example',
      title: 'Example Paper',
      authors: ['Alice Author'],
      year: 2020,
      venue: 'Journal',
    });
    vi.mocked(getOpenAlexWorkByDoi).mockResolvedValue(null);
    vi.mocked(getPaperById).mockResolvedValue(null);

    const result = await triangulateDoi('10.1234/example');
    const plain = triangulationResultToPlain(result);

    expect(plain.doi).toBe('10.1234/example');
    expect(plain.overall).toBeDefined();
    expect(Array.isArray(plain.records)).toBe(true);
  });
});
