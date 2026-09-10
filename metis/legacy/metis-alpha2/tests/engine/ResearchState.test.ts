/**
 * Tests for research_state aggregation — cross-session state recovery.
 * Round 306.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fsSync from 'node:fs';
import * as fs from 'node:fs/promises';
import * as path from 'node:path';
import * as os from 'node:os';
import { PersistenceStore, setSharedStore } from '../../engine/persistence/PersistenceStore.js';
import { addClaim, updateProjectMeta } from '../../engine/manifest/ClaimManifest.js';
import { saveReview } from '../../engine/manifest/ReviewStore.js';
import { researchStateHandler } from '../../engine/tools/builtin/academic-tools.js';

describe('research_state', () => {
  let originalDataDir: string | undefined;
  let tempDir: string;
  let dataDir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempDir = fsSync.mkdtempSync(path.join(os.tmpdir(), 'metis-research-state-'));
    dataDir = path.join(tempDir, 'data');
    fsSync.mkdirSync(dataDir, { recursive: true });
    process.env.METIS_DATA_DIR = dataDir;
    store = new PersistenceStore(path.join(tempDir, 'store.db'));
    setSharedStore(store);
  });

  afterEach(async () => {
    store.close();
    setSharedStore(null as unknown as PersistenceStore);
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('renders an empty state when nothing has been recorded', async () => {
    const out = await researchStateHandler({}, { sessionId: 't', workspace: tempDir, turnIndex: 0 });
    expect(out).toContain('Research State');
    expect(out).toContain('Papers: 0');
    expect(out).toContain('Claims');
    expect(out).toContain('Total: 0');
    expect(out).toContain('Reviews');
    expect(out).toContain('Raw JSON');
  });

  it('includes project name and research question when set', async () => {
    await updateProjectMeta({ projectName: 'Attention Study', researchQuestion: 'Do transformers scale?' });
    const out = await researchStateHandler({}, { sessionId: 't', workspace: tempDir, turnIndex: 0 });
    expect(out).toContain('Attention Study');
    expect(out).toContain('Do transformers scale?');
  });

  it('reports library stats from seeded papers', async () => {
    store.savePaper({
      id: 'p1', title: 'Paper One', authors: ['A'], year: 2023, venue: 'NeurIPS',
      abstract: 'abs', tags: ['nlp', 'cv'], notes: '', readStatus: 'read', rating: 4, addedAt: Date.now(),
    });
    store.savePaper({
      id: 'p2', title: 'Paper Two', authors: ['B'], year: 2024, venue: 'ICLR',
      abstract: 'abs', tags: ['nlp'], notes: '', readStatus: 'unread', rating: 0, addedAt: Date.now(),
    });

    const out = await researchStateHandler({}, { sessionId: 't', workspace: tempDir, turnIndex: 0 });
    expect(out).toContain('Papers: 2');
    expect(out).toContain('nlp');
  });

  it('summarizes claims by status', async () => {
    await addClaim({ claim: 'Transformers outperform RNNs', status: 'verified' });
    await addClaim({ claim: 'Attention is O(n^2)', status: 'gap' });
    await addClaim({ claim: 'Another claim', status: 'verified' });

    const out = await researchStateHandler({}, { sessionId: 't', workspace: tempDir, turnIndex: 0 });
    expect(out).toContain('Total: 3');
    expect(out).toContain('verified');
    expect(out).toContain('gap');
  });

  it('lists recent reviews', async () => {
    await saveReview({ scope: 'Paper A Review', overallScore: 8 });
    await saveReview({ scope: 'Paper B Review', overallScore: 6 });

    const out = await researchStateHandler({}, { sessionId: 't', workspace: tempDir, turnIndex: 0 });
    expect(out).toContain('Paper A Review');
    expect(out).toContain('Paper B Review');
    expect(out).toContain('8/10');
  });

  it('aggregates all three sources in one snapshot', async () => {
    await updateProjectMeta({ projectName: 'Multi-source Project' });
    store.savePaper({
      id: 'x', title: 'X', authors: ['Y'], year: 2024, venue: 'V',
      abstract: 'a', tags: ['t'], notes: '', readStatus: 'read', rating: 5, addedAt: Date.now(),
    });
    await addClaim({ claim: 'A claim', status: 'proposed' });
    await saveReview({ scope: 'X Review', overallScore: 9 });

    const out = await researchStateHandler({}, { sessionId: 't', workspace: tempDir, turnIndex: 0 });
    expect(out).toContain('Multi-source Project');
    expect(out).toContain('Papers: 1');
    expect(out).toContain('Total: 1');
    expect(out).toContain('X Review');
    // Raw JSON should include all three sections
    const jsonStart = out.indexOf('## Raw JSON');
    const json = out.slice(jsonStart);
    expect(json).toContain('"library"');
    expect(json).toContain('"claims"');
    expect(json).toContain('"reviews"');
  });

  it('degrades gracefully when the library store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const out = await researchStateHandler({}, { sessionId: 't', workspace: tempDir, turnIndex: 0 });
    expect(out).toContain('Research State');
    expect(out).toContain('not initialized');
    // claims and reviews should still work (they do not need the store)
    expect(out).toContain('Claims');
    expect(out).toContain('Reviews');
  });
});
