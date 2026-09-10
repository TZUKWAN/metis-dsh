/**
 * Tests for ContaminationScanner.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { scanDoi, scanAllPassports, scanAndRecordDoi, setJournalBlacklist, getJournalBlacklist } from '../../engine/research/ContaminationScanner.js';
import { recordTriangulation } from '../../engine/research/CitationPassport.js';
import { updateMirror } from '../../engine/research/RetractionWatchMirror.js';
import { updateMirror as updateJournalIntegrityMirror } from '../../engine/research/JournalIntegrityMirror.js';
import type { TriangulationResult } from '../../engine/research/CitationTriangulator.js';

vi.mock('../../engine/research/OpenAlexClient.js', () => ({
  getRawWorkByDoi: vi.fn(),
}));

vi.mock('../../engine/research/CrossrefClient.js', () => ({
  getRawWorkByDoi: vi.fn(),
}));

import * as OpenAlexClient from '../../engine/research/OpenAlexClient.js';
import * as CrossrefClient from '../../engine/research/CrossrefClient.js';

function makeResult(doi: string, overall: TriangulationResult['overall'] = 'VERIFIED'): TriangulationResult {
  return {
    doi,
    normalizedDoi: doi,
    existsIn: ['crossref'],
    missingIn: [],
    titleConsensus: 'full',
    yearConsensus: 'full',
    authorConsensus: 'full',
    overall,
    records: [],
    warnings: [],
  };
}

describe('ContaminationScanner', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;
  const originalBlacklist = [...getJournalBlacklist()];

  beforeEach(async () => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-scanner-test-${Date.now()}`);
    process.env.METIS_DATA_DIR = tempDir;
    vi.resetAllMocks();
    vi.mocked(CrossrefClient.getRawWorkByDoi).mockResolvedValue(null);
    setJournalBlacklist(['blacklisted journal']);
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
    setJournalBlacklist(originalBlacklist);
  });

  it('detects OpenAlex retraction signal', async () => {
    vi.mocked(OpenAlexClient.getRawWorkByDoi).mockResolvedValue({
      id: 'https://openalex.org/W1',
      doi: 'https://doi.org/10.1234/example',
      title: 'Example',
      is_retracted: true,
    } as unknown as Awaited<ReturnType<typeof OpenAlexClient.getRawWorkByDoi>>);

    const result = await scanDoi('10.1234/example');

    expect(result.signals).toHaveLength(1);
    expect(result.signals[0]!.type).toBe('retraction');
    expect(result.signals[0]!.source).toBe('openalex');
  });

  it('detects predatory journal via blacklist', async () => {
    vi.mocked(OpenAlexClient.getRawWorkByDoi).mockResolvedValue({
      id: 'https://openalex.org/W2',
      doi: 'https://doi.org/10.1234/example',
      title: 'Example',
      is_retracted: false,
      primary_location: {
        source: { display_name: 'Journal of Blacklisted Journal Research' },
      },
    } as unknown as Awaited<ReturnType<typeof OpenAlexClient.getRawWorkByDoi>>);

    const result = await scanDoi('10.1234/example');

    expect(result.signals.some((s) => s.type === 'predatory_journal')).toBe(true);
  });

  it('returns empty signals for clean work', async () => {
    vi.mocked(OpenAlexClient.getRawWorkByDoi).mockResolvedValue({
      id: 'https://openalex.org/W3',
      doi: 'https://doi.org/10.1234/example',
      title: 'Example',
      is_retracted: false,
      primary_location: {
        source: { display_name: 'Nature' },
      },
    } as unknown as Awaited<ReturnType<typeof OpenAlexClient.getRawWorkByDoi>>);

    const result = await scanDoi('10.1234/example');

    expect(result.signals).toHaveLength(0);
  });

  it('records signals into an existing passport', async () => {
    await recordTriangulation(makeResult('10.1234/example'));

    vi.mocked(OpenAlexClient.getRawWorkByDoi).mockResolvedValue({
      id: 'https://openalex.org/W4',
      doi: 'https://doi.org/10.1234/example',
      title: 'Example',
      is_retracted: true,
    } as unknown as Awaited<ReturnType<typeof OpenAlexClient.getRawWorkByDoi>>);

    const outcome = await scanAndRecordDoi('10.1234/example');

    expect(outcome.recorded).toBe(true);
    expect(outcome.signals).toHaveLength(1);
  });

  it('does not record when no passport exists', async () => {
    vi.mocked(OpenAlexClient.getRawWorkByDoi).mockResolvedValue({
      id: 'https://openalex.org/W5',
      doi: 'https://doi.org/10.1234/example',
      title: 'Example',
      is_retracted: true,
    } as unknown as Awaited<ReturnType<typeof OpenAlexClient.getRawWorkByDoi>>);

    const outcome = await scanAndRecordDoi('10.1234/example');

    expect(outcome.recorded).toBe(false);
    expect(outcome.signals).toHaveLength(1);
  });

  it('scans all passports and avoids duplicate signals', async () => {
    await recordTriangulation(makeResult('10.1234/a'));
    await recordTriangulation(makeResult('10.1234/b'));

    vi.mocked(OpenAlexClient.getRawWorkByDoi).mockImplementation(async (doi: string) => {
      const normalized = doi.replace('https://doi.org/', '').toLowerCase();
      return {
        id: `https://openalex.org/${normalized}`,
        doi: `https://doi.org/${normalized}`,
        title: 'Example',
        is_retracted: normalized === '10.1234/a',
        primary_location: { source: { display_name: 'Nature' } },
      } as unknown as Awaited<ReturnType<typeof OpenAlexClient.getRawWorkByDoi>>;
    });

    const summary = await scanAllPassports();

    expect(summary.scanned).toBe(2);
    expect(summary.newSignals).toBe(1);
    expect(summary.touched).toEqual(['10.1234/a']);

    // Second scan should not add duplicates.
    const second = await scanAllPassports();
    expect(second.newSignals).toBe(0);
  });

  it('detects Crossref update-to retraction signal', async () => {
    vi.mocked(CrossrefClient.getRawWorkByDoi).mockResolvedValue({
      DOI: '10.1234/example',
      title: ['Example'],
      'update-to': [
        { type: 'retraction', source: 'retraction-watch', label: 'Retraction', DOI: '10.1234/retraction' },
      ],
    } as unknown as Awaited<ReturnType<typeof CrossrefClient.getRawWorkByDoi>>);

    const result = await scanDoi('10.1234/example');

    expect(result.signals.some((s) => s.source === 'crossref-retraction-watch' && s.type === 'retraction')).toBe(true);
  });

  it('detects Crossref expression-of-concern signal', async () => {
    vi.mocked(CrossrefClient.getRawWorkByDoi).mockResolvedValue({
      DOI: '10.1234/example',
      title: ['Example'],
      'update-to': [
        { type: 'expression-of-concern', source: 'publisher', label: 'Expression of Concern' },
      ],
    } as unknown as Awaited<ReturnType<typeof CrossrefClient.getRawWorkByDoi>>);

    const result = await scanDoi('10.1234/example');

    expect(result.signals.some((s) => s.type === 'expression_of_concern')).toBe(true);
  });

  it('detects Retraction Watch CSV signal', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(`Record ID,Title,Subject,Institution,Journal,Publisher,Country,Author,URLS,ArticleType,RetractionDate,RetractionDOI,RetractionPubMedID,OriginalPaperDate,OriginalPaperDOI,OriginalPaperPubMedID,RetractionNature,Reason,Paywalled,Notes
1,Bad Paper,Science,University X,Bad Journal,Bad Publisher,USA,Alice,https://rw/1,Research Article,2024-01-15,10.9999/r1,0,2023-06-01,10.1234/example,0,Retraction,Falsification/Fabrication of Data,FALSE,Note 1
`),
    } as Response);

    await updateMirror();
    globalThis.fetch = originalFetch;

    vi.mocked(OpenAlexClient.getRawWorkByDoi).mockResolvedValue(null);
    vi.mocked(CrossrefClient.getRawWorkByDoi).mockResolvedValue(null);

    const result = await scanDoi('10.1234/example');

    expect(result.signals.some((s) => s.source === 'retraction-watch-csv' && s.type === 'retraction')).toBe(true);
  });

  it('detects hijacked journal signal via venue title', async () => {
    const originalFetch = globalThis.fetch;
    globalThis.fetch = vi.fn().mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(`Journal,ISSN,Hijacked URL,Notes
Real Journal,1111-2222,https://fake-real-journal.com,Impersonating legitimate journal
`),
    } as Response);

    await updateJournalIntegrityMirror('hijacked_journal');
    globalThis.fetch = originalFetch;

    vi.mocked(OpenAlexClient.getRawWorkByDoi).mockResolvedValue({
      id: 'https://openalex.org/W6',
      doi: 'https://doi.org/10.1234/example',
      title: 'Example',
      is_retracted: false,
      primary_location: {
        source: { display_name: 'Real Journal' },
      },
    } as unknown as Awaited<ReturnType<typeof OpenAlexClient.getRawWorkByDoi>>);
    vi.mocked(CrossrefClient.getRawWorkByDoi).mockResolvedValue(null);

    const result = await scanDoi('10.1234/example');

    expect(result.signals.some((s) => s.type === 'predatory_journal' && s.source === 'retraction-watch-hijacked-journal-checker')).toBe(true);
  });
});
