/**
 * Citation Passport — persistent Material Passport for cited works.
 *
 * Stores the triangulation history and contamination signals of a DOI so that
 * cross-session research can build up an auditable record of whether a citation
 * is trustworthy. Inspired by ARS v3.8 Material Passport.
 *
 * Data is stored in the Metis data directory under `manifest/citation-passports.json`.
 */

import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import type { TriangulationResult } from './CitationTriangulator.js';

export type ContaminationType =
  | 'retraction'
  | 'expression_of_concern'
  | 'journal_blacklist'
  | 'predatory_journal'
  | 'data_fabrication'
  | 'other';

export interface ContaminationSignal {
  source: string;
  type: ContaminationType;
  url?: string;
  details?: string;
  detectedAt: number;
}

export interface TriangulationSnapshot {
  overall: TriangulationResult['overall'];
  titleConsensus: TriangulationResult['titleConsensus'];
  yearConsensus: TriangulationResult['yearConsensus'];
  authorConsensus: TriangulationResult['authorConsensus'];
  existsIn: string[];
  missingIn: string[];
  warnings: string[];
  triangulatedAt: number;
}

export interface CitationPassportEntry {
  doi: string;
  normalizedDoi: string;
  overall: TriangulationResult['overall'];
  titleConsensus: TriangulationResult['titleConsensus'];
  yearConsensus: TriangulationResult['yearConsensus'];
  authorConsensus: TriangulationResult['authorConsensus'];
  existsIn: string[];
  missingIn: string[];
  warnings: string[];
  lastTriangulatedAt: number;
  triangulationHistory: TriangulationSnapshot[];
  contaminationSignals: ContaminationSignal[];
  createdAt: number;
  updatedAt: number;
}

interface CitationPassportDb {
  version: number;
  updatedAt: number;
  passports: CitationPassportEntry[];
}

const PASSPORT_VERSION = 1;

function getDataDir(): string {
  if (process.env.METIS_DATA_DIR) return process.env.METIS_DATA_DIR;
  try {
    return path.join(process.cwd(), '.metis-data');
  } catch {
    return path.join(os.tmpdir(), 'metis-data');
  }
}

function getPassportDir(): string {
  return path.join(getDataDir(), 'manifest');
}

function getPassportPath(): string {
  return path.join(getPassportDir(), 'citation-passports.json');
}

async function ensurePassportDir(): Promise<void> {
  await fs.mkdir(getPassportDir(), { recursive: true });
}

function emptyDb(): CitationPassportDb {
  return { version: PASSPORT_VERSION, updatedAt: Date.now(), passports: [] };
}

export function normalizeDoi(doi: string): string {
  return doi
    .trim()
    .replace(/^https?:\/\/doi\.org\//i, '')
    .replace(/^doi:/i, '')
    .toLowerCase();
}

export async function loadPassports(): Promise<CitationPassportDb> {
  try {
    await ensurePassportDir();
    const raw = await fs.readFile(getPassportPath(), 'utf-8');
    const parsed = JSON.parse(raw) as CitationPassportDb;
    if (!parsed || typeof parsed !== 'object' || !Array.isArray(parsed.passports)) {
      return emptyDb();
    }
    return { ...emptyDb(), ...parsed, passports: parsed.passports };
  } catch {
    return emptyDb();
  }
}

async function savePassports(db: CitationPassportDb): Promise<void> {
  await ensurePassportDir();
  db.updatedAt = Date.now();
  await fs.writeFile(getPassportPath(), JSON.stringify(db, null, 2), 'utf-8');
}

function resultToSnapshot(result: TriangulationResult): TriangulationSnapshot {
  return {
    overall: result.overall,
    titleConsensus: result.titleConsensus,
    yearConsensus: result.yearConsensus,
    authorConsensus: result.authorConsensus,
    existsIn: result.existsIn,
    missingIn: result.missingIn,
    warnings: result.warnings,
    triangulatedAt: Date.now(),
  };
}

function createEntry(result: TriangulationResult): CitationPassportEntry {
  const now = Date.now();
  return {
    doi: result.doi,
    normalizedDoi: result.normalizedDoi,
    overall: result.overall,
    titleConsensus: result.titleConsensus,
    yearConsensus: result.yearConsensus,
    authorConsensus: result.authorConsensus,
    existsIn: result.existsIn,
    missingIn: result.missingIn,
    warnings: result.warnings,
    lastTriangulatedAt: now,
    triangulationHistory: [resultToSnapshot(result)],
    contaminationSignals: [],
    createdAt: now,
    updatedAt: now,
  };
}

function updateEntry(entry: CitationPassportEntry, result: TriangulationResult): CitationPassportEntry {
  entry.normalizedDoi = result.normalizedDoi;
  entry.overall = result.overall;
  entry.titleConsensus = result.titleConsensus;
  entry.yearConsensus = result.yearConsensus;
  entry.authorConsensus = result.authorConsensus;
  entry.existsIn = result.existsIn;
  entry.missingIn = result.missingIn;
  entry.warnings = result.warnings;
  entry.lastTriangulatedAt = Date.now();
  entry.triangulationHistory.push(resultToSnapshot(result));
  entry.updatedAt = Date.now();
  return entry;
}

/**
 * Get an existing passport by DOI (case-insensitive, ignores https://doi.org/ prefix).
 */
export async function getPassport(doi: string): Promise<CitationPassportEntry | undefined> {
  const normalized = normalizeDoi(doi);
  const db = await loadPassports();
  return db.passports.find((p) => p.normalizedDoi === normalized);
}

/**
 * Record a triangulation result for a DOI, creating or updating the passport.
 */
export async function recordTriangulation(result: TriangulationResult): Promise<CitationPassportEntry> {
  const db = await loadPassports();
  const normalized = result.normalizedDoi;
  const idx = db.passports.findIndex((p) => p.normalizedDoi === normalized);

  let entry: CitationPassportEntry;
  if (idx === -1) {
    entry = createEntry(result);
    db.passports.push(entry);
  } else {
    entry = updateEntry(db.passports[idx]!, result);
    db.passports[idx] = entry;
  }

  await savePassports(db);
  return entry;
}

/**
 * Add a contamination signal to a passport. Returns undefined if passport not found.
 */
export async function addContaminationSignal(
  doi: string,
  signal: Omit<ContaminationSignal, 'detectedAt'>,
): Promise<CitationPassportEntry | undefined> {
  const db = await loadPassports();
  const normalized = normalizeDoi(doi);
  const entry = db.passports.find((p) => p.normalizedDoi === normalized);
  if (!entry) return undefined;

  entry.contaminationSignals.push({ ...signal, detectedAt: Date.now() });
  entry.updatedAt = Date.now();
  await savePassports(db);
  return entry;
}

/**
 * List all passports, optionally filtered by overall status.
 */
export async function listPassports(filter?: {
  overall?: TriangulationResult['overall'];
}): Promise<CitationPassportEntry[]> {
  const db = await loadPassports();
  if (!filter?.overall) return db.passports;
  return db.passports.filter((p) => p.overall === filter.overall);
}

/**
 * Delete a passport by DOI.
 */
export async function deletePassport(doi: string): Promise<boolean> {
  const db = await loadPassports();
  const normalized = normalizeDoi(doi);
  const initialLength = db.passports.length;
  db.passports = db.passports.filter((p) => p.normalizedDoi !== normalized);
  if (db.passports.length === initialLength) return false;
  await savePassports(db);
  return true;
}

/**
 * Convert a passport entry to a plain object for tool output.
 */
export function passportToPlain(entry: CitationPassportEntry): Record<string, unknown> {
  return {
    doi: entry.doi,
    normalizedDoi: entry.normalizedDoi,
    overall: entry.overall,
    titleConsensus: entry.titleConsensus,
    yearConsensus: entry.yearConsensus,
    authorConsensus: entry.authorConsensus,
    existsIn: entry.existsIn,
    missingIn: entry.missingIn,
    warnings: entry.warnings,
    lastTriangulatedAt: entry.lastTriangulatedAt,
    triangulationCount: entry.triangulationHistory.length,
    contaminationSignals: entry.contaminationSignals,
    createdAt: entry.createdAt,
    updatedAt: entry.updatedAt,
  };
}
