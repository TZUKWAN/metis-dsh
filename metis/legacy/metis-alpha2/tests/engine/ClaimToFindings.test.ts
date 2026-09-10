/**
 * Tests for claim_to_findings — bridge from verified claims to the findings log.
 * Round 313.
 */

import { describe, it, expect, beforeEach, afterEach } from 'vitest';
import * as fs from 'node:fs';
import * as path from 'node:path';
import * as os from 'node:os';
import { addClaim } from '../../engine/manifest/ClaimManifest.js';
import { listFindings, clearFindings } from '../../engine/workspace/FindingsLog.js';
import { claimToFindingsHandler } from '../../engine/tools/builtin/academic-tools.js';

describe('claim_to_findings', () => {
  let originalDataDir: string | undefined;
  let tempBase: string;
  let dataDir: string;
  let workspaceRoot: string;

  beforeEach(() => {
    originalDataDir = process.env.METIS_DATA_DIR;
    tempBase = fs.mkdtempSync(path.join(os.tmpdir(), 'metis-claim2f-'));
    dataDir = path.join(tempBase, 'data');
    workspaceRoot = path.join(tempBase, 'workspace');
    fs.mkdirSync(dataDir, { recursive: true });
    fs.mkdirSync(workspaceRoot, { recursive: true });
    process.env.METIS_DATA_DIR = dataDir;
  });

  afterEach(async () => {
    if (originalDataDir !== undefined) {
      process.env.METIS_DATA_DIR = originalDataDir;
    } else {
      delete process.env.METIS_DATA_DIR;
    }
    await fs.promises.rm(tempBase, { recursive: true, force: true });
  });

  it('converts verified claims into findings by default', async () => {
    await addClaim({ claim: 'Attention is O(n^2).', status: 'verified', doi: '10.1/a' });
    await addClaim({ claim: 'A speculative idea.', status: 'proposed' });
    await clearFindings();

    const out = await claimToFindingsHandler(
      {},
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    expect(out).toContain('Claim → Findings');
    expect(out).toContain('1 claim(s)');

    const findings = await listFindings();
    expect(findings.length).toBe(1);
    expect(findings[0]!.text).toContain('Attention is O(n^2)');
    expect(findings[0]!.text).toContain('Verified claim');
  });

  it('skips non-verified claims by default (no pollution)', async () => {
    await addClaim({ claim: 'unverified', status: 'proposed' });
    await addClaim({ claim: 'also unverified', status: 'gap' });
    await clearFindings();

    await claimToFindingsHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    const findings = await listFindings();
    expect(findings.length).toBe(0);
  });

  it('respects a custom status filter', async () => {
    await addClaim({ claim: 'verified one', status: 'verified' });
    await addClaim({ claim: 'gap one', status: 'gap' });
    await addClaim({ claim: 'proposed one', status: 'proposed' });
    await clearFindings();

    const out = await claimToFindingsHandler(
      { status: 'gap' },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    expect(out).toContain('status "gap"');
    const findings = await listFindings();
    expect(findings.length).toBe(1);
    expect(findings[0]!.text).toContain('gap one');
  });

  it('tags findings with claim + status + source id', async () => {
    await addClaim({ claim: 'tagged claim', status: 'verified', doi: '10.1/xyz' });
    await clearFindings();

    await claimToFindingsHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    const findings = await listFindings();
    expect(findings[0]!.tags).toContain('claim');
    expect(findings[0]!.tags).toContain('verified');
    expect(findings[0]!.tags).toContain('10.1/xyz');
  });

  it('sources findings to claim:<id>', async () => {
    const added = await addClaim({ claim: 'sourced claim', status: 'verified' });
    await clearFindings();

    await claimToFindingsHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    const findings = await listFindings();
    expect(findings[0]!.source).toBe(`claim:${added.id}`);
  });

  it('uses the given confidence (default high)', async () => {
    await addClaim({ claim: 'conf claim', status: 'verified' });
    await clearFindings();

    await claimToFindingsHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    let findings = await listFindings();
    expect(findings[0]!.confidence).toBe('high');

    await clearFindings();
    await claimToFindingsHandler({ confidence: 'low' }, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    findings = await listFindings();
    expect(findings[0]!.confidence).toBe('low');
  });

  it('appends to findings.md when workspaceRoot is given', async () => {
    await addClaim({ claim: 'md claim', status: 'verified' });
    await clearFindings();

    await claimToFindingsHandler(
      { workspaceRoot },
      { sessionId: 't', workspace: tempBase, turnIndex: 0 },
    );
    const md = await fs.promises.readFile(path.join(workspaceRoot, 'findings.md'), 'utf-8');
    expect(md).toContain('md claim');
    expect(md).toContain('Verified claim');
  });

  it('reports when no claims match the status', async () => {
    await addClaim({ claim: 'only proposed', status: 'proposed' });
    const out = await claimToFindingsHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    expect(out).toContain('No claims');
    expect(out).toContain('verified');
  });

  it('falls back to arxivId then source then id for the source tag', async () => {
    await addClaim({ claim: 'doi claim', status: 'verified', doi: '10.1/d' });
    await addClaim({ claim: 'arxiv claim', status: 'verified', arxivId: '2401.00001' });
    await addClaim({ claim: 'src claim', status: 'verified', source: 'manual-note' });
    const c4 = await addClaim({ claim: 'idonly claim', status: 'verified' });
    await clearFindings();

    await claimToFindingsHandler({}, { sessionId: 't', workspace: tempBase, turnIndex: 0 });
    const findings = await listFindings();
    const byText = new Map(findings.map((f) => [f.text, f]));
    expect(byText.get('Verified claim: doi claim')?.tags).toContain('10.1/d');
    expect(byText.get('Verified claim: arxiv claim')?.tags).toContain('2401.00001');
    expect(byText.get('Verified claim: src claim')?.tags).toContain('manual-note');
    expect(byText.get('Verified claim: idonly claim')?.tags).toContain(c4.id);
    // Verify all 4 converted
    expect(findings.length).toBe(4);
  });
});
