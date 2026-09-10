/**
 * Contamination scanner — detect retraction / expression-of-concern / predatory-journal signals.
 *
 * Polls public bibliographic sources (OpenAlex, Crossref, and a local journal blacklist)
 * to surface contamination signals that should be recorded in a Citation Passport.
 */

import * as OpenAlexClient from './OpenAlexClient.js';
import * as CrossrefClient from './CrossrefClient.js';
import * as RetractionWatchMirror from './RetractionWatchMirror.js';
import * as JournalIntegrityMirror from './JournalIntegrityMirror.js';
import { addContaminationSignal, getPassport, listPassports, normalizeDoi } from './CitationPassport.js';

export interface ScanSignal {
  source: string;
  type: 'retraction' | 'expression_of_concern' | 'journal_blacklist' | 'predatory_journal' | 'data_fabrication' | 'other';
  details: string;
  url?: string;
}

export interface ScanResult {
  doi: string;
  normalizedDoi: string;
  signals: ScanSignal[];
  scannedAt: number;
}

// A conservative default list of known predatory / low-quality publishers and journal name fragments.
// Users can override via setJournalBlacklist() for their domain.
let journalBlacklist: string[] = [
  'scientific research publishing',
  'scirp',
  'omics international',
  'omics publishing group',
  'academic journals',
  'world academic publishing',
  'waset',
  'international association of engineers',
];

/**
 * Replace the default journal blacklist. Used mainly in tests.
 */
export function setJournalBlacklist(list: string[]): void {
  journalBlacklist = list.map((s) => s.toLowerCase());
}

export function getJournalBlacklist(): readonly string[] {
  return journalBlacklist;
}

function normalizeText(input: string): string {
  return input.toLowerCase().replace(/[^a-z0-9 ]/g, ' ').replace(/\s+/g, ' ').trim();
}

function checkBlacklist(venue?: string, publisher?: string): ScanSignal | undefined {
  const venueNorm = normalizeText(venue ?? '');
  const publisherNorm = normalizeText(publisher ?? '');

  for (const entry of journalBlacklist) {
    if (venueNorm.includes(entry) || publisherNorm.includes(entry)) {
      return {
        source: 'local_journal_blacklist',
        type: 'predatory_journal',
        details: `Venue or publisher matched blacklist entry: "${entry}"`,
      };
    }
  }
  return undefined;
}

function mapUpdateType(type?: string): ScanSignal['type'] | undefined {
  switch (type?.toLowerCase()) {
    case 'retraction':
      return 'retraction';
    case 'expression-of-concern':
    case 'expression_of_concern':
      return 'expression_of_concern';
    case 'correction':
      return 'other';
    default:
      return 'other';
  }
}

async function scanOpenAlex(doi: string): Promise<ScanSignal[]> {
  const signals: ScanSignal[] = [];
  try {
    const work = await OpenAlexClient.getRawWorkByDoi(doi);
    if (!work) return signals;

    if (work.is_retracted === true) {
      signals.push({
        source: 'openalex',
        type: 'retraction',
        details: 'OpenAlex marks this work as retracted.',
        url: work.id,
      });
    }

    const source = work.primary_location?.source;
    const venue = source?.display_name;
    const publisher = source?.type; // OpenAlex Source does not expose publisher directly
    const blacklistSignal = checkBlacklist(venue, publisher);
    if (blacklistSignal) signals.push(blacklistSignal);
  } catch {
    // Network/source failures are non-fatal; return empty signals.
  }
  return signals;
}

async function scanCrossref(doi: string): Promise<ScanSignal[]> {
  const signals: ScanSignal[] = [];
  try {
    const work = await CrossrefClient.getRawWorkByDoi(doi);
    if (!work) return signals;

    const updates = work['update-to'];
    if (!Array.isArray(updates) || updates.length === 0) return signals;

    for (const update of updates) {
      const mappedType = mapUpdateType(update.type);
      if (!mappedType) continue;
      const source = update.source ? `crossref-${update.source}` : 'crossref';
      const label = update.label ? ` [${update.label}]` : '';
      const updateDoi = update.DOI ? ` (notice DOI: ${update.DOI})` : '';
      signals.push({
        source,
        type: mappedType,
        details: `Crossref update-to entry:${label}${updateDoi}`,
        url: update.DOI ? `https://doi.org/${update.DOI}` : work.URL,
      });
    }
  } catch {
    // Network/source failures are non-fatal; return empty signals.
  }
  return signals;
}

function mapRetractionWatchNature(nature: string): ScanSignal['type'] | undefined {
  switch (nature.toLowerCase()) {
    case 'retraction':
      return 'retraction';
    case 'expression of concern':
      return 'expression_of_concern';
    case 'correction':
      return 'other';
    case 'reinstatement':
      return 'other';
    default:
      return 'other';
  }
}

async function scanRetractionWatch(doi: string): Promise<ScanSignal[]> {
  const signals: ScanSignal[] = [];
  try {
    const entries = await RetractionWatchMirror.lookupDoi(doi);
    if (!entries || entries.length === 0) return signals;

    for (const entry of entries) {
      const mappedType = mapRetractionWatchNature(entry.retractionNature);
      if (!mappedType) continue;
      const parts = [`Retraction Watch record ${entry.recordId}`];
      if (entry.retractionNature) parts.push(`nature: ${entry.retractionNature}`);
      if (entry.reason) parts.push(`reason: ${entry.reason}`);
      if (entry.retractionDate) parts.push(`date: ${entry.retractionDate}`);
      signals.push({
        source: 'retraction-watch-csv',
        type: mappedType,
        details: parts.join('; '),
        url: entry.urls ? entry.urls.split(';')[0]?.trim() : entry.retractionDoi ? `https://doi.org/${entry.retractionDoi}` : undefined,
      });
    }
  } catch {
    // Local mirror failures are non-fatal.
  }
  return signals;
}

function mapJournalIntegrityType(type: JournalIntegrityMirror.JournalIntegrityType): ScanSignal['type'] {
  switch (type) {
    case 'doaj_withdrawn':
      return 'journal_blacklist';
    case 'hijacked_journal':
      return 'predatory_journal';
    default:
      return 'other';
  }
}

async function scanJournalIntegrity(doi: string): Promise<ScanSignal[]> {
  const signals: ScanSignal[] = [];
  try {
    const work = await OpenAlexClient.getRawWorkByDoi(doi);
    const source = work?.primary_location?.source;
    if (!source) return signals;

    const title = source.display_name;
    const issn = source.issn_l ?? source.issn?.[0];
    if (!title && !issn) return signals;

    const entries = await JournalIntegrityMirror.lookupVenue(title, issn);
    for (const entry of entries) {
      signals.push({
        source: entry.source,
        type: mapJournalIntegrityType(entry.type),
        details: entry.details ?? `${entry.type}: ${entry.title ?? ''}`,
        url: entry.url,
      });
    }
  } catch {
    // Local mirror failures are non-fatal.
  }
  return signals;
}

/**
 * Scan a single DOI for contamination signals.
 */
export async function scanDoi(doi: string): Promise<ScanResult> {
  const normalized = normalizeDoi(doi);
  const [openAlexSignals, crossrefSignals, rwSignals, journalSignals] = await Promise.all([
    scanOpenAlex(normalized),
    scanCrossref(normalized),
    scanRetractionWatch(normalized),
    scanJournalIntegrity(normalized),
  ]);

  return {
    doi,
    normalizedDoi: normalized,
    signals: [...openAlexSignals, ...crossrefSignals, ...rwSignals, ...journalSignals],
    scannedAt: Date.now(),
  };
}

/**
 * Scan all recorded passports and append any newly discovered contamination signals.
 * Returns a summary of touched passports and total new signals.
 */
export async function scanAllPassports(): Promise<{ scanned: number; newSignals: number; touched: string[] }> {
  const passports = await listPassports();
  let newSignals = 0;
  const touched: string[] = [];

  for (const passport of passports) {
    const result = await scanDoi(passport.normalizedDoi);
    let added = 0;

    for (const signal of result.signals) {
      // Avoid duplicate signals from the same source with the same type.
      const alreadyExists = passport.contaminationSignals.some(
        (s) => s.source === signal.source && s.type === signal.type,
      );
      if (alreadyExists) continue;

      const updated = await addContaminationSignal(passport.normalizedDoi, signal);
      if (updated) {
        added += 1;
      }
    }

    if (added > 0) {
      newSignals += added;
      touched.push(passport.normalizedDoi);
    }
  }

  return { scanned: passports.length, newSignals, touched };
}

/**
 * Scan a single DOI and record any signals into its Citation Passport.
 * Creates a passport only if signals are found (to avoid empty entries).
 */
export async function scanAndRecordDoi(doi: string): Promise<{ signals: ScanSignal[]; recorded: boolean }> {
  const result = await scanDoi(doi);
  if (result.signals.length === 0) {
    return { signals: [], recorded: false };
  }

  const existing = await getPassport(doi);
  if (!existing) {
    // We do not create a passport here because there is no triangulation result yet.
    // Signal recording will fail gracefully; callers should run citation_passport_record first.
    return { signals: result.signals, recorded: false };
  }

  let added = 0;
  for (const signal of result.signals) {
    const alreadyExists = existing.contaminationSignals.some(
      (s) => s.source === signal.source && s.type === signal.type,
    );
    if (alreadyExists) continue;
    const updated = await addContaminationSignal(doi, signal);
    if (updated) added += 1;
  }

  return { signals: result.signals, recorded: added > 0 };
}

export function scanResultToPlain(result: ScanResult): Record<string, unknown> {
  return {
    doi: result.doi,
    normalizedDoi: result.normalizedDoi,
    signalCount: result.signals.length,
    signals: result.signals,
    scannedAt: result.scannedAt,
  };
}
