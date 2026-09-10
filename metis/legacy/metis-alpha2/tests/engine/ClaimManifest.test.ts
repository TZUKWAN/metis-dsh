/**
 * Tests for ClaimManifest.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import {
  loadManifest,
  addClaim,
  updateClaim,
  listClaims,
  findClaim,
  deleteClaim,
  updateProjectMeta,
  manifestToPlain,
  claimToPlain,
} from '../../engine/manifest/ClaimManifest.js';

describe('ClaimManifest', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;

  beforeEach(async () => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = path.join(os.tmpdir(), `metis-manifest-test-${Date.now()}`);
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

  it('loads an empty manifest when none exists', async () => {
    const manifest = await loadManifest();
    expect(manifest.claims).toEqual([]);
    expect(manifest.version).toBe(1);
  });

  it('adds and lists claims', async () => {
    const entry = await addClaim({
      claim: 'X improves Y.',
      source: 'Smith et al. 2020',
      doi: '10.1234/x',
      status: 'proposed',
    });

    expect(entry.id).toBeDefined();
    expect(entry.claim).toBe('X improves Y.');

    const claims = await listClaims();
    expect(claims).toHaveLength(1);
    expect(claims[0]?.status).toBe('proposed');
  });

  it('updates a claim status', async () => {
    const entry = await addClaim({ claim: 'A causes B.', status: 'proposed' });
    const updated = await updateClaim(entry.id, { status: 'verified', evidenceArtifacts: ['doi:10.1234/x'] });

    expect(updated).not.toBeNull();
    expect(updated?.status).toBe('verified');
    expect(updated?.evidenceArtifacts).toEqual(['doi:10.1234/x']);
  });

  it('filters claims by status', async () => {
    await addClaim({ claim: 'One', status: 'verified' });
    await addClaim({ claim: 'Two', status: 'gap' });

    const verified = await listClaims({ status: 'verified' });
    expect(verified).toHaveLength(1);
    expect(verified[0]?.claim).toBe('One');
  });

  it('deletes a claim', async () => {
    const entry = await addClaim({ claim: 'To delete', status: 'proposed' });
    const deleted = await deleteClaim(entry.id);

    expect(deleted).toBe(true);
    const claims = await listClaims();
    expect(claims).toHaveLength(0);
  });

  it('updates project metadata', async () => {
    await updateProjectMeta({ projectName: 'Neural NLI', researchQuestion: 'Can transformers reason?' });

    const manifest = await loadManifest();
    expect(manifest.projectName).toBe('Neural NLI');
    expect(manifest.researchQuestion).toBe('Can transformers reason?');
  });

  it('converts manifest to plain object', async () => {
    await addClaim({ claim: 'Plain', status: 'proposed' });
    const manifest = await loadManifest();
    const plain = manifestToPlain(manifest);

    expect(plain.projectName).toBeUndefined();
    expect(plain.claimCount).toBe(1);
    expect(Array.isArray(plain.claims)).toBe(true);
  });

  it('converts a claim to plain object', () => {
    const entry = {
      id: '1',
      claim: 'C',
      status: 'verified' as const,
      createdAt: 0,
      updatedAt: 0,
    };
    const plain = claimToPlain(entry);

    expect(plain.id).toBe('1');
    expect(plain.status).toBe('verified');
  });

  it('finds a claim by id', async () => {
    const entry = await addClaim({ claim: 'Find me', status: 'proposed', doi: '10.1234/find' });
    const found = await findClaim({ id: entry.id });
    expect(found?.id).toBe(entry.id);
  });

  it('finds a claim by doi', async () => {
    await addClaim({ claim: 'By DOI', status: 'proposed', doi: '10.1234/doi' });
    const found = await findClaim({ doi: '10.1234/doi' });
    expect(found?.claim).toBe('By DOI');
  });

  it('finds a claim by exact claim text', async () => {
    await addClaim({ claim: 'Exact text match', status: 'proposed' });
    const found = await findClaim({ claim: 'Exact text match' });
    expect(found?.claim).toBe('Exact text match');
  });

  it('returns null when no claim matches', async () => {
    const found = await findClaim({ doi: '10.0000/nothing' });
    expect(found).toBeNull();
  });
});
