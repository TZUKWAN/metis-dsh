/**
 * Tests for RetractionWatchMirror.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  updateMirror,
  lookupDoi,
  loadMirror,
  isMirrorStale,
} from '../../engine/research/RetractionWatchMirror.js';

const sampleCsv = `Record ID,Title,Subject,Institution,Journal,Publisher,Country,Author,URLS,ArticleType,RetractionDate,RetractionDOI,RetractionPubMedID,OriginalPaperDate,OriginalPaperDOI,OriginalPaperPubMedID,RetractionNature,Reason,Paywalled,Notes
1,Bad Paper,Science,University X,Bad Journal,Bad Publisher,USA,Alice,https://rw/1,Research Article,2024-01-15,10.9999/r1,0,2023-06-01,10.1234/example,0,Retraction,Falsification/Fabrication of Data;Investigation by Journal/Publisher,FALSE,Note 1
2,Concern Paper,Science,University Y,Worry Journal,Worry Publisher,UK,Bob,https://rw/2,Research Article,2024-02-20,,0,2023-07-01,10.1234/example,0,Expression of Concern,Concerns/Issues About Data,FALSE,Note 2
`;

describe('RetractionWatchMirror', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-rw-test-${Date.now()}`);
    process.env.METIS_DATA_DIR = tempDir;
    globalThis.fetch = vi.fn();
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    globalThis.fetch = originalFetch;
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  function mockFetchCsv(text: string) {
    vi.mocked(globalThis.fetch).mockResolvedValueOnce({
      ok: true,
      status: 200,
      statusText: 'OK',
      text: () => Promise.resolve(text),
    } as Response);
  }

  it('updates mirror from CSV and indexes by original DOI', async () => {
    mockFetchCsv(sampleCsv);

    const result = await updateMirror();

    expect(result.entryCount).toBe(2); // rows with valid OriginalPaperDOI
    const entries = await lookupDoi('10.1234/example');
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(2);
    expect(entries?.some((e) => e.retractionNature === 'Retraction')).toBe(true);
    expect(entries?.some((e) => e.retractionNature === 'Expression of Concern')).toBe(true);
  });

  it('normalizes DOI with prefix and uppercase', async () => {
    mockFetchCsv(sampleCsv);
    await updateMirror();

    const entries = await lookupDoi('https://doi.org/10.1234/EXAMPLE');
    expect(entries).toBeDefined();
    expect(entries).toHaveLength(2);
  });

  it('returns undefined for unknown DOI', async () => {
    mockFetchCsv(sampleCsv);
    await updateMirror();

    const entries = await lookupDoi('10.0000/unknown');
    expect(entries).toBeUndefined();
  });

  it('skips update when mirror is fresh', async () => {
    mockFetchCsv(sampleCsv);
    await updateMirror();

    const stale = await isMirrorStale();
    expect(stale).toBe(false);

    const result = await updateMirror();
    expect(result.entryCount).toBe(2);
    // Fetch should only have been called once.
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('forces update when requested', async () => {
    mockFetchCsv(sampleCsv);
    await updateMirror();

    mockFetchCsv(sampleCsv);
    const result = await updateMirror({ force: true });
    expect(result.entryCount).toBe(2);
    expect(globalThis.fetch).toHaveBeenCalledTimes(2);
  });

  it('loads mirror stats', async () => {
    mockFetchCsv(sampleCsv);
    await updateMirror();

    const mirror = await loadMirror();
    expect(mirror).not.toBeNull();
    expect(mirror?.entryCount).toBe(2);
    expect(Object.keys(mirror?.byDoi ?? {})).toHaveLength(1);
  });
});
