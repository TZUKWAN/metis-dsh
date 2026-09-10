/**
 * Journal integrity mirror — local caches for venue-level integrity signals.
 *
 * Supports:
 * - DOAJ withdrawn-journals list (journals removed from DOAJ for misconduct).
 * - Retraction Watch Hijacked Journal Checker (journals impersonated by predatory sites).
 *
 * Data sources are public Google Sheets / CSVs. The module normalises ISSNs and
 * journal titles for conservative exact-match lookups.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { parse } from 'csv-parse/sync';

export type JournalIntegrityType = 'doaj_withdrawn' | 'hijacked_journal';

export interface JournalIntegrityEntry {
  type: JournalIntegrityType;
  source: string;
  title?: string;
  normalizedTitle?: string;
  issn?: string;
  normalizedIssn?: string;
  reason?: string;
  date?: string;
  url?: string;
  details?: string;
}

interface JournalIntegrityIndex {
  version: number;
  updatedAt: number;
  sourceUrl: string;
  type: JournalIntegrityType;
  byIssn: Record<string, JournalIntegrityEntry[]>;
  byTitle: Record<string, JournalIntegrityEntry[]>;
}

const MIRROR_VERSION = 1;
const DEFAULT_MAX_AGE_MS = 24 * 60 * 60 * 1000;

export const DEFAULT_DOAJ_WITHDRAWN_URL =
  'https://docs.google.com/spreadsheets/d/1AKf5p5VwCSjW1rCWrmXunydCnqSnm1F7m1FdQ04IS14/export?format=csv';
export const DEFAULT_HIJACKED_JOURNAL_URL =
  'https://docs.google.com/spreadsheets/d/1ak985WGOgGbJRJbZFanoktAN_UFeExpE/export?format=csv&gid=5255084';

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

function getIndexPath(type: JournalIntegrityType): string {
  const fileName = type === 'doaj_withdrawn' ? 'doaj-withdrawn.json' : 'hijacked-journals.json';
  return path.join(getMirrorDir(), fileName);
}

async function ensureMirrorDir(): Promise<void> {
  await fs.mkdir(getMirrorDir(), { recursive: true });
}

function normalizeIssn(issn: string): string {
  return issn.replace(/[^0-9Xx]/g, '').toUpperCase();
}

function normalizeTitle(title: string): string {
  return title
    .toLowerCase()
    .replace(/[^a-z0-9]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

function findColumn(row: Record<string, string>, candidates: string[]): string | undefined {
  const keys = Object.keys(row);
  for (const candidate of candidates) {
    const lower = candidate.toLowerCase();
    const key = keys.find((k) => k.toLowerCase().trim() === lower || k.toLowerCase().includes(lower));
    if (key) return row[key];
  }
  return undefined;
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

function buildDoajIndex(rows: Record<string, string>[], sourceUrl: string): JournalIntegrityIndex {
  const byIssn: Record<string, JournalIntegrityEntry[]> = {};
  const byTitle: Record<string, JournalIntegrityEntry[]> = {};

  for (const row of rows) {
    const title = findColumn(row, ['Journal', 'Journal Title', 'Title']);
    const issn = findColumn(row, ['ISSN', 'EISSN', 'issn']);
    const reason = findColumn(row, ['Reason', 'Reason for removal', 'Reason removed', 'Removal reason']);
    const date = findColumn(row, ['Date removed', 'Date Removed', 'Removal date', 'Removed']);

    if (!title && !issn) continue;

    const normalizedTitle = title ? normalizeTitle(title) : undefined;
    const normalizedIssn = issn ? normalizeIssn(issn) : undefined;

    const entry: JournalIntegrityEntry = {
      type: 'doaj_withdrawn',
      source: 'doaj-withdrawn-list',
      title,
      normalizedTitle,
      issn,
      normalizedIssn,
      reason,
      date,
      details: `Journal removed from DOAJ${reason ? `: ${reason}` : ''}`,
    };

    if (normalizedIssn) {
      if (!byIssn[normalizedIssn]) byIssn[normalizedIssn] = [];
      byIssn[normalizedIssn]!.push(entry);
    }
    if (normalizedTitle) {
      if (!byTitle[normalizedTitle]) byTitle[normalizedTitle] = [];
      byTitle[normalizedTitle]!.push(entry);
    }
  }

  return {
    version: MIRROR_VERSION,
    updatedAt: Date.now(),
    sourceUrl,
    type: 'doaj_withdrawn',
    byIssn,
    byTitle,
  };
}

function buildHijackedIndex(rows: Record<string, string>[], sourceUrl: string): JournalIntegrityIndex {
  const byIssn: Record<string, JournalIntegrityEntry[]> = {};
  const byTitle: Record<string, JournalIntegrityEntry[]> = {};

  for (const row of rows) {
    const title = findColumn(row, ['Journal', 'Original journal', 'Journal title', 'Title', 'Journal Title']);
    const issn = findColumn(row, ['ISSN', 'issn', 'Original ISSN']);
    const url = findColumn(row, ['URL', 'Hijacked URL', 'Website', 'Hijacked website']);
    const reason = findColumn(row, ['Notes', 'Comment', 'Reason']);

    if (!title && !issn) continue;

    const normalizedTitle = title ? normalizeTitle(title) : undefined;
    const normalizedIssn = issn ? normalizeIssn(issn) : undefined;

    const entry: JournalIntegrityEntry = {
      type: 'hijacked_journal',
      source: 'retraction-watch-hijacked-journal-checker',
      title,
      normalizedTitle,
      issn,
      normalizedIssn,
      reason,
      url,
      details: `Journal may be impersonated by a hijacked website${url ? `: ${url}` : ''}`,
    };

    if (normalizedIssn) {
      if (!byIssn[normalizedIssn]) byIssn[normalizedIssn] = [];
      byIssn[normalizedIssn]!.push(entry);
    }
    if (normalizedTitle) {
      if (!byTitle[normalizedTitle]) byTitle[normalizedTitle] = [];
      byTitle[normalizedTitle]!.push(entry);
    }
  }

  return {
    version: MIRROR_VERSION,
    updatedAt: Date.now(),
    sourceUrl,
    type: 'hijacked_journal',
    byIssn,
    byTitle,
  };
}

export async function loadIndex(type: JournalIntegrityType): Promise<JournalIntegrityIndex | null> {
  try {
    const raw = await fs.readFile(getIndexPath(type), 'utf-8');
    const parsed = JSON.parse(raw) as JournalIntegrityIndex;
    if (!parsed || typeof parsed !== 'object' || parsed.version !== MIRROR_VERSION || parsed.type !== type) {
      return null;
    }
    return parsed;
  } catch {
    return null;
  }
}

export async function isMirrorStale(type: JournalIntegrityType, maxAgeMs = DEFAULT_MAX_AGE_MS): Promise<boolean> {
  const index = await loadIndex(type);
  if (!index) return true;
  return Date.now() - index.updatedAt > maxAgeMs;
}

export async function updateMirror(
  type: JournalIntegrityType,
  options?: { url?: string; force?: boolean; timeoutMs?: number },
): Promise<{ entryCount: number; updatedAt: number }> {
  const url = options?.url ?? (type === 'doaj_withdrawn' ? DEFAULT_DOAJ_WITHDRAWN_URL : DEFAULT_HIJACKED_JOURNAL_URL);

  if (!options?.force && !(await isMirrorStale(type))) {
    const existing = await loadIndex(type);
    if (existing) {
      return {
        entryCount: Object.keys(existing.byIssn).length + Object.keys(existing.byTitle).length,
        updatedAt: existing.updatedAt,
      };
    }
  }

  const csvText = await fetchCsv(url, options?.timeoutMs);
  const rows = parseCsv(csvText);
  const index = type === 'doaj_withdrawn' ? buildDoajIndex(rows, url) : buildHijackedIndex(rows, url);

  await ensureMirrorDir();
  await fs.writeFile(getIndexPath(type), JSON.stringify(index, null, 2), 'utf-8');

  return {
    entryCount: Object.keys(index.byIssn).length + Object.keys(index.byTitle).length,
    updatedAt: index.updatedAt,
  };
}

export async function updateAllMirrors(options?: { force?: boolean; timeoutMs?: number }): Promise<{
  doaj: { entryCount: number; updatedAt: number };
  hijacked: { entryCount: number; updatedAt: number };
}> {
  const [doaj, hijacked] = await Promise.all([
    updateMirror('doaj_withdrawn', options),
    updateMirror('hijacked_journal', options),
  ]);
  return { doaj, hijacked };
}

export async function lookupVenue(title?: string, issn?: string): Promise<JournalIntegrityEntry[]> {
  const results: JournalIntegrityEntry[] = [];
  const seen = new Set<string>();

  const add = (entry: JournalIntegrityEntry) => {
    const key = `${entry.type}|${entry.title ?? ''}|${entry.issn ?? ''}|${entry.reason ?? ''}`;
    if (seen.has(key)) return;
    seen.add(key);
    results.push(entry);
  };

  const normalizedTitle = title ? normalizeTitle(title) : undefined;
  const normalizedIssn = issn ? normalizeIssn(issn) : undefined;

  for (const type of ['doaj_withdrawn', 'hijacked_journal'] as JournalIntegrityType[]) {
    const index = await loadIndex(type);
    if (!index) continue;

    if (normalizedIssn && index.byIssn[normalizedIssn]) {
      for (const entry of index.byIssn[normalizedIssn]!) add(entry);
    }
    if (normalizedTitle && index.byTitle[normalizedTitle]) {
      for (const entry of index.byTitle[normalizedTitle]!) add(entry);
    }
  }

  return results;
}

export function entryToPlain(entry: JournalIntegrityEntry): Record<string, unknown> {
  return {
    type: entry.type,
    source: entry.source,
    title: entry.title,
    issn: entry.issn,
    reason: entry.reason,
    date: entry.date,
    url: entry.url,
    details: entry.details,
  };
}

export function indexStatsToPlain(index: JournalIntegrityIndex): Record<string, unknown> {
  return {
    type: index.type,
    sourceUrl: index.sourceUrl,
    updatedAt: index.updatedAt,
    uniqueIssnCount: Object.keys(index.byIssn).length,
    uniqueTitleCount: Object.keys(index.byTitle).length,
  };
}
