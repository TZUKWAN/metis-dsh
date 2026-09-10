/**
 * Tests for JournalIntegrityMirror.
 */

import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  updateMirror,
  updateAllMirrors,
  lookupVenue,
  loadIndex,
  isMirrorStale,
} from '../../engine/research/JournalIntegrityMirror.js';

const doajCsv = `Journal,ISSN,Reason,Date removed
Predatory OA Journal,1234-5678,Editorial misconduct,2023-01-10
Another Bad Journal,8765-4321,Predatory practices,2023-02-15
`;

const hijackedCsv = `Journal,ISSN,Hijacked URL,Notes
Real Journal,1111-2222,https://fake-real-journal.com,Impersonating legitimate journal
`;

describe('JournalIntegrityMirror', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;
  const originalFetch = globalThis.fetch;

  beforeEach(async () => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-ji-test-${Date.now()}`);
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

  it('updates DOAJ withdrawn mirror and looks up by ISSN', async () => {
    mockFetchCsv(doajCsv);

    const result = await updateMirror('doaj_withdrawn');
    expect(result.entryCount).toBeGreaterThan(0);

    const flags = await lookupVenue(undefined, '1234-5678');
    expect(flags.some((f) => f.type === 'doaj_withdrawn')).toBe(true);
  });

  it('updates hijacked journal mirror and looks up by title', async () => {
    mockFetchCsv(hijackedCsv);

    const result = await updateMirror('hijacked_journal');
    expect(result.entryCount).toBeGreaterThan(0);

    const flags = await lookupVenue('Real Journal');
    expect(flags.some((f) => f.type === 'hijacked_journal')).toBe(true);
  });

  it('updates all mirrors', async () => {
    mockFetchCsv(doajCsv);
    mockFetchCsv(hijackedCsv);

    const result = await updateAllMirrors();
    expect(result.doaj.entryCount).toBeGreaterThan(0);
    expect(result.hijacked.entryCount).toBeGreaterThan(0);
  });

  it('skips update when mirror is fresh', async () => {
    mockFetchCsv(doajCsv);
    await updateMirror('doaj_withdrawn');

    const stale = await isMirrorStale('doaj_withdrawn');
    expect(stale).toBe(false);

    const result = await updateMirror('doaj_withdrawn');
    expect(result.entryCount).toBeGreaterThan(0);
    expect(globalThis.fetch).toHaveBeenCalledTimes(1);
  });

  it('loads index stats', async () => {
    mockFetchCsv(doajCsv);
    await updateMirror('doaj_withdrawn');

    const index = await loadIndex('doaj_withdrawn');
    expect(index).not.toBeNull();
    expect(index?.type).toBe('doaj_withdrawn');
  });
});
