/**
 * Tests for CitationPassport persistence.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadPassports,
  getPassport,
  recordTriangulation,
  addContaminationSignal,
  listPassports,
  deletePassport,
  passportToPlain,
  normalizeDoi,
} from '../../engine/research/CitationPassport.js';
import type { TriangulationResult } from '../../engine/research/CitationTriangulator.js';

function makeResult(overrides: Partial<TriangulationResult> = {}): TriangulationResult {
  return {
    doi: '10.1234/example',
    normalizedDoi: '10.1234/example',
    existsIn: ['crossref'],
    missingIn: ['open_alex', 'semantic_scholar'],
    titleConsensus: 'full',
    yearConsensus: 'full',
    authorConsensus: 'full',
    overall: 'VERIFIED',
    records: [],
    warnings: [],
    ...overrides,
  };
}

describe('CitationPassport', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-passport-test-${Date.now()}`);
    process.env.METIS_DATA_DIR = tempDir;
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('loads an empty passport database when none exists', async () => {
    const db = await loadPassports();
    expect(db.passports).toEqual([]);
    expect(db.version).toBe(1);
  });

  it('normalizes DOI input', () => {
    expect(normalizeDoi('https://doi.org/10.1234/EXAMPLE')).toBe('10.1234/example');
    expect(normalizeDoi('doi:10.1234/Example')).toBe('10.1234/example');
  });

  it('creates a passport from a triangulation result', async () => {
    const entry = await recordTriangulation(makeResult());

    expect(entry.doi).toBe('10.1234/example');
    expect(entry.overall).toBe('VERIFIED');
    expect(entry.triangulationHistory).toHaveLength(1);
  });

  it('updates an existing passport on re-triangulation', async () => {
    await recordTriangulation(makeResult({ overall: 'PARTIAL' }));
    const updated = await recordTriangulation(makeResult({ overall: 'VERIFIED' }));

    expect(updated.overall).toBe('VERIFIED');
    expect(updated.triangulationHistory).toHaveLength(2);
  });

  it('retrieves a passport by normalized DOI', async () => {
    await recordTriangulation(makeResult());
    const found = await getPassport('https://doi.org/10.1234/EXAMPLE');

    expect(found).toBeDefined();
    expect(found?.normalizedDoi).toBe('10.1234/example');
  });

  it('returns undefined for unknown DOI', async () => {
    const found = await getPassport('10.0000/unknown');
    expect(found).toBeUndefined();
  });

  it('adds contamination signals', async () => {
    await recordTriangulation(makeResult());
    const entry = await addContaminationSignal('10.1234/example', {
      source: 'retractionwatch',
      type: 'retraction',
      details: 'Paper retracted due to fabricated data',
    });

    expect(entry).toBeDefined();
    expect(entry!.contaminationSignals).toHaveLength(1);
    expect(entry!.contaminationSignals[0]!.type).toBe('retraction');
  });

  it('lists passports with optional overall filter', async () => {
    await recordTriangulation(makeResult({ doi: '10.1/a', normalizedDoi: '10.1/a', overall: 'VERIFIED' }));
    await recordTriangulation(makeResult({ doi: '10.1/b', normalizedDoi: '10.1/b', overall: 'NOT_FOUND' }));

    const all = await listPassports();
    expect(all).toHaveLength(2);

    const verified = await listPassports({ overall: 'VERIFIED' });
    expect(verified).toHaveLength(1);
    expect(verified[0]?.overall).toBe('VERIFIED');
  });

  it('deletes a passport', async () => {
    await recordTriangulation(makeResult());
    const deleted = await deletePassport('10.1234/example');

    expect(deleted).toBe(true);
    const all = await listPassports();
    expect(all).toHaveLength(0);
  });

  it('converts passport to plain object', async () => {
    const entry = await recordTriangulation(makeResult());
    const plain = passportToPlain(entry);

    expect(plain.doi).toBe('10.1234/example');
    expect(plain.overall).toBe('VERIFIED');
    expect(plain.triangulationCount).toBe(1);
    expect(Array.isArray(plain.contaminationSignals)).toBe(true);
  });
});
