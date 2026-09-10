/**
 * Tests for research_summary — narrative progress summary.
 * Round 315.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { PersistenceStore, setSharedStore } from '../../engine/persistence/PersistenceStore.js';
import { updateProjectMeta, addClaim } from '../../engine/manifest/ClaimManifest.js';
import { saveReview } from '../../engine/manifest/ReviewStore.js';
import { addFinding, clearFindings } from '../../engine/workspace/FindingsLog.js';
import { researchSummaryHandler } from '../../engine/tools/builtin/academic-tools.js';

describe('research_summary', () => {
  let originalDataDir: string | undefined;
  let tempBase: string;
  let dataDir: string;
  let store: PersistenceStore;

  beforeEach(() => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-rsum-'));
    dataDir = path.join(tempBase, 'data');
    fs.mkdirSync(dataDir, { recursive: true });
    process.env.METIS_DATA_DIR = dataDir;
    store = new PersistenceStore(path.join(tempBase, 'store.db'));
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
    await fs.promises.rm(tempBase, { recursive: true, force: true });
  });

  it('renders a title and empty-state guidance when nothing is set', async () => {
    await clearFindings();
    const out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('Research Progress Summary');
    expect(out).toContain('No project name');
    expect(out).toContain('Suggested next steps');
    // Should suggest setting up basics.
    expect(out.toLowerCase()).toContain('project name');
  });

  it('includes project name and research question in the narrative', async () => {
    await updateProjectMeta({ projectName: 'Efficiency Study', researchQuestion: 'Can we make attention linear?' });
    const out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('Efficiency Study');
    expect(out).toContain('Can we make attention linear?');
  });

  it('describes the corpus with paper count and read percentage', async () => {
    store.savePaper({ id: 'p1', title: 'A', authors: ['X'], year: 2023, venue: 'V', abstract: 'a', tags: ['nlp'], notes: '', readStatus: 'read', rating: 5, addedAt: 1 });
    store.savePaper({ id: 'p2', title: 'B', authors: ['Y'], year: 2024, venue: 'V', abstract: 'b', tags: ['nlp'], notes: '', readStatus: 'unread', rating: 0, addedAt: 2 });
    const out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('2 paper(s)');
    expect(out).toContain('50% read');
  });

  it('narrates claim status including open gaps', async () => {
    await addClaim({ claim: 'verified one', status: 'verified' });
    await addClaim({ claim: 'gap one', status: 'gap' });
    await addClaim({ claim: 'proposed one', status: 'proposed' });
    const out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('3 claim(s)');
    expect(out).toContain('verified');
    expect(out).toMatch(/1 open gap|are 1 open gaps/);
  });

  it('lists recent findings with confidence and tag count', async () => {
    await clearFindings();
    await addFinding({ text: 'first finding', tags: ['a','b'], confidence: 'high' });
    await addFinding({ text: 'second finding', tags: ['c'], confidence: 'medium' });
    const out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('2 finding(s)');
    expect(out).toContain('1 at high confidence');
    expect(out).toContain('first finding');
  });

  it('narrates saved reviews with average score', async () => {
    await saveReview({ scope: 'Paper A', overallScore: 8 });
    await saveReview({ scope: 'Paper B', overallScore: 6 });
    const out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('review(s) saved');
    expect(out).toContain('7.0/10'); // avg of 8 and 6
    expect(out).toContain('Paper A');
  });

  it('produces context-aware suggested next steps', async () => {
    // Empty project → suggests setup.
    let out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('Set a project name');

    // After setup but no corpus → suggests building corpus.
    await updateProjectMeta({ projectName: 'P', researchQuestion: 'Q?' });
    out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('Build the corpus');

    // With corpus but duplicates → suggests cleanup.
    store.savePaper({ id: 'p1', title: 'Attention Is All You Need', authors: ['X'], year: 2023, venue: 'V', abstract: 'a', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 1 });
    store.savePaper({ id: 'p2', title: 'Attention Is All You Need', authors: ['X'], year: 2023, venue: 'V', abstract: 'a', tags: [], notes: '', readStatus: 'unread', rating: 0, addedAt: 2 });
    out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('delete_library_duplicates');
  });

  it('handles a fully-populated project gracefully', async () => {
    await updateProjectMeta({ projectName: 'Complete', researchQuestion: 'Done?' });
    store.savePaper({ id: 'p1', title: 'Paper', authors: ['A'], year: 2024, venue: 'V', abstract: 'a', tags: ['x'], notes: '', readStatus: 'read', rating: 5, addedAt: 1 });
    await addClaim({ claim: 'verified', status: 'verified' });
    await clearFindings();
    await addFinding({ text: 'a finding', tags: ['x'], confidence: 'high' });
    await saveReview({ scope: 'Paper', overallScore: 9 });
    const out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('Complete');
    expect(out).toContain('1 paper(s)');
    expect(out).toContain('1 claim(s)');
    expect(out).toContain('1 finding(s)');
    expect(out).toContain('review(s) saved');
    // No gaps → suggests export/draft.
    expect(out).toMatch(/export|draft|well-rounded/i);
  });

  it('degrades gracefully when store is not initialized', async () => {
    setSharedStore(null as unknown as PersistenceStore);
    const out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('Research Progress Summary');
    // Claims/findings still work without the store.
    expect(out).toContain('Claims');
  });

  it('does NOT crash when findings log is empty', async () => {
    await clearFindings();
    const out = await researchSummaryHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('No findings recorded');
  });
});
