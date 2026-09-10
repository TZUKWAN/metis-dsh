/**
 * Retraction Watch mirror — local cache of the Crossref Labs RW CSV.
 *
 * Provides fast offline lookups of retraction / expression-of-concern / correction
 * records by original paper DOI, including richer reason metadata.
 *
 * Data source: https://api.labs.crossref.org/data/retractionwatch
 * License: public Retraction Watch data distributed by Crossref.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse } from 'csv-parse/sync';

export interface RetractionWatchEntry {
  recordId: string;
  originalDoi: string;
  normalizedOriginalDoi: string;
  retractionDoi?: string;
  retractionNature: string;
  reason?: string;
  retractionDate?: string;
  title?: string;
  journal?: string;
  publisher?: string;
  urls?: string;
  notes?: string;
}

interface RetractionWatchIndex {
  version: number;
  updatedAt: number;
  sourceUrl: string;
  entryCount: number;
  byDoi: Record<string, RetractionWatchEntry[]>;
}

const MIRROR_VERSION = 1;
const DEFAULT_CSV_URL = 'https://api.labs.crossref.org/data/retractionwatch';
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000; // 24 hours

function getDataDir(): string {
  if (process.env.METIS_DATA_DIR) return process.env.METIS_DATA_DIR;
  try {
    return path.join(process.cwd(), '.metis-data');
  } catch {
    return path.join(os.tmpdir(), 'metis-data');
  }
}

function getMirrorDir(): string {
  return path.join(getDataDir(), 'manifest');
}

function getMirrorPath(): string {
  return path.join(getMirrorDir(), 'retraction-watch.json');
}

async function ensureMirrorDir(): Promise<void> {
  await fs.mkdir(getMirrorDir(), { recursive: true });
}

function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .toLowerCase();
}

function cleanDoi(value: string | undefined): string | undefined {
  if (!value) return undefined;
  const trimmed = value.trim();
  if (!trimmed || trimmed.toLowerCase() === 'unavailable') return undefined;
  return normalizeDoi(trimmed);
}

function mapNature(nature?: string): string {
  return (nature ?? '').trim();
}

function buildIndex(rows: Record<string, string>[], sourceUrl: string): RetractionWatchIndex {
  const byDoi: Record<string, RetractionWatchEntry[]> = {};
  let entryCount = 0;

  for (const row of rows) {
    const originalDoi = cleanDoi(row['OriginalPaperDOI']);
    if (!originalDoi) continue;

    const retractionDoi = cleanDoi(row['RetractionDOI']);
    const entry: RetractionWatchEntry = {
      recordId: (row['Record ID'] ?? '').trim(),
      originalDoi: (row['OriginalPaperDOI'] ?? '').trim(),
      normalizedOriginalDoi: originalDoi,
      retractionDoi,
      retractionNature: mapNature(row['RetractionNature']),
      reason: (row['Reason'] ?? '').trim() || undefined,
      retractionDate: (row['RetractionDate'] ?? '').trim() || undefined,
      title: (row['Title'] ?? '').trim() || undefined,
      journal: (row['Journal'] ?? '').trim() || undefined,
      publisher: (row['Publisher'] ?? '').trim() || undefined,
      urls: (row['URLS'] ?? '').trim() || undefined,
      notes: (row['Notes'] ?? '').trim() || undefined,
    };

    if (!byDoi[originalDoi]) byDoi[originalDoi] = [];
    byDoi[originalDoi]!.push(entry);
    entryCount += 1;
  }

  return {
    version: MIRROR_VERSION,
    updatedAt: Date.now(),
    sourceUrl,
    entryCount,
    byDoi,
  };
}

async function fetchCsv(url: string, timeoutMs = 60000): Promise<string> {
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const response = await fetch(url, {
      headers: { Accept: 'text/csv, text/plain, */*' },
      signal: controller.signal,
    });
    if (!response.ok) {
      throw new Error(`HTTP ${response.status} ${response.statusText}`);
    }
    return await response.text();
  } finally {
    clearTimeout(timeoutId);
  }
}

function parseCsv(csvText: string): Record<string, string>[] {
  return parse(csvText, {
    columns: true,
    skip_empty_lines: true,
    trim: true,
  }) as Record<string, string>[];
}

/**
 * Load the local mirror index from disk.
 */
export async function loadMirror(): Promise<RetractionWatchIndex | null> {
  try {
    const raw = await fs.readFile(getMirrorPath(), 'utf-8');
    const parsed = JSON.parse(raw) as RetractionWatchIndex;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== MIRROR_VERSION) return null;
    return parsed;
  } catch {
    return null;
  }
}

/**
 * Check whether the local mirror is missing or older than maxAgeMs.
 */
export async function isMirrorStale(maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<boolean> {
  const mirror = await loadMirror();
  if (!mirror) return true;
  return Date.now() - mirror.updatedAt > maxAgeMs;
}

/**
 * Update the local mirror by downloading the Retraction Watch CSV.
 */
export async function updateMirror(options?: { url?: string; force?: boolean; timeoutMs?: number }): Promise<{
  entryCount: number;
  updatedAt: number;
}> {
  const url = options?.url ?? DEFAULT_CSV_URL;

  if (!options?.force && !(await isMirrorStale())) {
    const existing = await loadMirror();
    if (existing) {
      return { entryCount: existing.entryCount, updatedAt: existing.updatedAt };
    }
  }

  const csvText = await fetchCsv(url, options?.timeoutMs);
  const rows = parseCsv(csvText);
  const index = buildIndex(rows, url);

  await ensureMirrorDir();
  await fs.writeFile(getMirrorPath(), JSON.stringify(index, null, 2), 'utf-8');

  return { entryCount: index.entryCount, updatedAt: index.updatedAt };
}

/**
 * Look up a DOI in the local mirror.
 */
export async function lookupDoi(doi: string): Promise<RetractionWatchEntry[] | undefined> {
  const normalized = normalizeDoi(doi);
  const mirror = await loadMirror();
  if (!mirror) return undefined;
  return mirror.byDoi[normalized];
}

export function entryToPlain(entry: RetractionWatchEntry): Record<string, unknown> {
  return {
    recordId: entry.recordId,
    originalDoi: entry.originalDoi,
    retractionDoi: entry.retractionDoi,
    retractionNature: entry.retractionNature,
    reason: entry.reason,
    retractionDate: entry.retractionDate,
    title: entry.title,
    journal: entry.journal,
    publisher: entry.publisher,
    urls: entry.urls,
    notes: entry.notes,
  };
}

export function mirrorStatsToPlain(index: RetractionWatchIndex): Record<string, unknown> {
  return {
    version: index.version,
    updatedAt: index.updatedAt,
    sourceUrl: index.sourceUrl,
    entryCount: index.entryCount,
    uniqueDoiCount: Object.keys(index.byDoi).length,
  };
}
